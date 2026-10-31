// Where provider CLIs live on this computer. The bridge may be started from a
// terminal, by the API on this computer, or (soon) by a desktop app opened
// from the Dock or Start menu, and only a terminal has the PATH the person's
// shell builds (Homebrew, nvm, npm and Bun installs). So the bridge searches,
// and runs every CLI with, one effective PATH:
//
//   1. its own PATH;
//   2. the PATH of the person's login shell, read once (bounded, best effort);
//   3. well-known install folders, for when neither has them.
//
// Folders inside node_modules are never searched: a project dependency must
// not stand in for a provider CLI.
import { readdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { capture } from "./process.js"

/** Install folders the common installers use, newest nvm Node first. */
export function knownDirectories(home: string, platform: NodeJS.Platform, list: (dir: string) => string[] = safeList): string[] {
  if (platform === "win32") return [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, "AppData", "Roaming", "npm")]
  const nvm = join(home, ".nvm", "versions", "node")
  const nodes = list(nvm).filter(v => /^v\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => compareVersions(b, a)).map(v => join(nvm, v, "bin"))
  return [
    join(home, ".local", "bin"), join(home, ".opencode", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin",
    join(home, ".npm-global", "bin"), join(home, ".bun", "bin"), join(home, ".volta", "bin"),
    join(home, ".local", "share", "pnpm"), join(home, "Library", "pnpm"),
    ...nodes,
  ]
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir) } catch { return [] }
}
function compareVersions(a: string, b: string) {
  const x = a.slice(1).split(".").map(Number), y = b.slice(1).split(".").map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** The effective search path: the given PATHs then the known folders, de-duplicated, without node_modules. */
export function mergePaths(paths: ReadonlyArray<string | null | undefined>, known: ReadonlyArray<string>): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const dir of [...paths.flatMap(p => (p ?? "").split(delimiter)), ...known]) {
    const d = dir.trim()
    if (!d || d.includes("node_modules") || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}

const MARK = "__OPENRECORD_PATH__"
/** The PATH between the markers in a login shell's output; rc files may print around it. */
export const parseShellPath = (output: string): string | null => {
  const m = output.match(new RegExp(`${MARK}(.*?)${MARK}`, "s"))
  return m?.[1]?.trim() || null
}

let shellPath: Promise<string | null> | null = null
/** The login shell's PATH, read once per bridge process; null on Windows or when the shell does not answer in time. */
export function loginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null)
  return shellPath ??= (async () => {
    try {
      const shell = env["SHELL"]?.startsWith("/") ? env["SHELL"] : "/bin/zsh"
      // Only what a shell needs to start: no provider or application secrets.
      const minimal: NodeJS.ProcessEnv = { HOME: env["HOME"] ?? homedir(), USER: env["USER"], LOGNAME: env["LOGNAME"], SHELL: shell, PATH: env["PATH"], TERM: "dumb" }
      const out = await capture(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], tmpdir(), minimal, "", AbortSignal.timeout(5000), [0, 1])
      return parseShellPath(out)
    } catch { return null }
  })()
}

let effective: string | null = null
/** Computes the effective PATH once; later calls reuse it. */
export async function prepareSearchPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (effective !== null) return effective
  const home = env["HOME"] ?? homedir()
  effective = mergePaths([env["PATH"], await loginShellPath(env)], knownDirectories(home, process.platform)).join(delimiter)
  return effective
}
/** The effective PATH if prepared, else the bridge's own. */
export const searchPath = () => effective ?? process.env["PATH"] ?? ""
