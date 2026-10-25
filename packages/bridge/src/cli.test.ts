import { createServer } from "node:http"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { build } from "esbuild"
import { expect, it } from "vitest"

it("starts the downloadable bundle through a symlinked folder without project dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openrecord-bundle-test-"))
  try {
    const real = join(directory, "real"),
      linked = join(directory, "linked")
    await mkdir(real)
    await symlink(real, linked, "dir")
    await build({
      entryPoints: [fileURLToPath(new URL("./main.ts", import.meta.url))],
      outfile: join(real, "bridge.mjs"),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm"
    })
    const result = await promisify(execFile)(process.execPath, [join(linked, "bridge.mjs"), "--help"], {
      cwd: directory
    })
    expect(result.stdout).toContain("OpenRecord local harness bridge")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

it("runs the CLI through outbound polling, a fixture provider, result delivery, and clean shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openrecord-cli-test-"))
  const root = join(directory, ".openrecord")
  const binary = join(directory, "fixture")
  const token = "t".repeat(43)
  const localId = randomUUID(),
    id = randomUUID(),
    lease = randomUUID()
  let claimed = false
  let delivered: unknown
  let resolveResult: () => void = () => undefined
  const completed = new Promise<void>((resolve) => {
    resolveResult = resolve
  })
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += String(chunk)
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end()
      return
    }
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/bridge/poll") {
      const poll = JSON.parse(body)
      const job =
        !claimed &&
        poll.reports.some(
          (report: { localId: string; state: string }) => report.localId === localId && report.state === "ready"
        )
          ? {
              id,
              lease,
              localId,
              driver: "codex",
              model: "fixture-model",
              input: { system: "TEST", contents: [{ role: "user", parts: [{ text: "TEST message" }] }], tools: [] }
            }
          : null
      if (job) claimed = true
      response.end(JSON.stringify({ job, active: claimed ? [id] : [] }))
    } else if (request.url === `/api/bridge/jobs/${id}/result`) {
      delivered = JSON.parse(body)
      response.end("{}")
      resolveResult()
    } else response.writeHead(404).end("{}")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("TEST listener missing")
  let child: ReturnType<typeof spawn> | undefined
  try {
    await mkdir(root, { mode: 0o700 })
    await copyFile(fileURLToPath(new URL("./fixtures/harness.mjs", import.meta.url)), binary)
    await chmod(binary, 0o700)
    await writeFile(
      join(root, "bridge.json"),
      JSON.stringify({
        server: `http://127.0.0.1:${address.port}`,
        bridgeId: randomUUID(),
        token,
        instances: [{ id: localId, driver: "codex", name: "TEST", binary }]
      }),
      { mode: 0o600 }
    )
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url)), "run"], {
      env: { ...process.env, HOME: directory },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout?.on("data", (chunk) => {
      output += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      output += String(chunk)
    })
    await Promise.race([
      completed,
      once(child, "exit").then(() => {
        throw new Error(`TEST bridge exited: ${output}`)
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`TEST result timeout: ${output}`)), 45000).unref())
    ])
    expect(delivered).toEqual({ lease, kind: "completed", answer: { kind: "text", text: "TEST Codex reply" } })
    const exit = once(child, "exit")
    child.kill("SIGTERM")
    await exit
    expect(await readFile(join(root, "bridge.json"), "utf8")).toContain(token)
    await expect(readFile(join(root, "bridge.lock"))).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
