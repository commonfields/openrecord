// A local stand-in for the GitHub REST endpoints delivery uses, backed by the
// fixture transport. Tests run the real fetch transport against it; for a
// local demo, point GITHUB_DELIVERY_API_URL at it (loopback only). It never
// talks to GitHub.
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { GitHubError, gitBlobSha, type fixtureGitHub } from "./github-delivery.js"

type Fixture = ReturnType<typeof fixtureGitHub>

const readBody = (req: IncomingMessage) => new Promise<unknown>((resolve) => {
  let data = ""
  req.on("data", (c: Buffer) => { data += c.toString("utf8") })
  req.on("end", () => { try { resolve(data ? JSON.parse(data) : null) } catch { resolve(null) } })
})

export const serveFixtureGitHub = async (fixture: Fixture, opts: { token: string }) => {
  const t = fixture.transport
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
    if (req.headers["authorization"] !== `Bearer ${opts.token}`) return send(401, { message: "Bad credentials" })
    const url = new URL(req.url ?? "/", "http://localhost")
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!m) return send(404, { message: "Not Found" })
    const owner = decodeURIComponent(m[1]!), repo = decodeURIComponent(m[2]!), rest = m[3] ?? ""
    const pr = (p: Awaited<ReturnType<typeof t.pullRequest>>) => ({ number: p.number, html_url: p.url, head: { sha: p.headSha }, state: p.state, merged: p.merged,
      merge_commit_sha: p.mergeCommitSha, merged_at: p.mergedAt, closed_at: p.closedAt })
    try {
      if (req.method === "GET" && rest === "") {
        const r = await t.repository(owner, repo)
        return r ? send(200, { default_branch: r.defaultBranch }) : send(404, { message: "Not Found" })
      }
      const ref = /^\/git\/ref\/heads\/(.+)$/.exec(rest)
      if (req.method === "GET" && ref) {
        const sha = await t.branchHead(owner, repo, ref[1]!.split("/").map(decodeURIComponent).join("/"))
        return sha ? send(200, { object: { sha } }) : send(404, { message: "Not Found" })
      }
      const contents = /^\/contents\/(.+)$/.exec(rest)
      if (contents) {
        const path = contents[1]!.split("/").map(decodeURIComponent).join("/")
        if (req.method === "GET") {
          const f = await t.file(owner, repo, path, url.searchParams.get("ref") ?? "")
          if (f.kind !== "file") return send(404, { message: "Not Found" })
          return send(200, { type: "file", size: Buffer.byteLength(f.content), encoding: "base64", sha: f.blobSha, content: Buffer.from(f.content).toString("base64") })
        }
        if (req.method === "PUT") {
          const body = await readBody(req) as { message: string; branch: string; sha: string; content: string }
          const content = Buffer.from(body.content, "base64").toString("utf8")
          const r = await t.putFile(owner, repo, { path, branch: body.branch, content, expectedBlobSha: body.sha, message: body.message })
          return send(200, { content: { sha: gitBlobSha(content) }, commit: { sha: r.commitSha } })
        }
      }
      if (req.method === "POST" && rest === "/git/refs") {
        const body = await readBody(req) as { ref: string; sha: string }
        const result = await t.createBranch(owner, repo, body.ref.replace(/^refs\/heads\//, ""), body.sha)
        return result === "created" ? send(201, { ref: body.ref }) : send(422, { message: "Reference already exists" })
      }
      if (req.method === "GET" && rest === "/pulls") {
        const head = (url.searchParams.get("head") ?? "").replace(/^[^:]+:/, "")
        const found = await t.findPullRequest(owner, repo, head, url.searchParams.get("base") ?? "")
        return send(200, found ? [pr(found)] : [])
      }
      if (req.method === "POST" && rest === "/pulls") {
        const body = await readBody(req) as { head: string; base: string; title: string; body: string }
        return send(201, pr(await t.createPullRequest(owner, repo, body)))
      }
      const number = /^\/pulls\/(\d+)$/.exec(rest)
      if (req.method === "GET" && number) return send(200, pr(await t.pullRequest(owner, repo, Number(number[1]))))
      return send(404, { message: "Not Found" })
    } catch (e) {
      if (e instanceof GitHubError) {
        // GitHub answers 422 for an existing pull request and 409 for a stale file.
        if (e.kind === "CONFLICT") return send(req.method === "POST" && rest === "/pulls" ? 422 : 409, { message: e.message })
        if (e.kind === "NOT_FOUND") return send(404, { message: e.message })
        if (e.kind === "TIMEOUT" || e.kind === "UNAVAILABLE") { res.destroy(); return }
        return send(422, { message: e.message })
      }
      return send(500, { message: "fixture error" })
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
