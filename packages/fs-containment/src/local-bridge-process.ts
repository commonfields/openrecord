// Narrow local-mode process capability: the only hosted-graph code allowed to
// start a subprocess. It starts this Node binary running the bridge program,
// for a managed bridge home, with an environment the caller has already
// reduced to an allowlist. No shell, no other executable.
import { spawn } from "node:child_process"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

const enabled = () => /^(1|true|on)$/i.test(process.env["OPENRECORD_LOCAL_BRIDGE"] ?? "")
const base = () => resolve(process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] ?? join(homedir(), ".openrecord", "app"))

export const startManagedBridge = (dir: string, args: ReadonlyArray<string>, options: { readonly cwd?: string; readonly env: NodeJS.ProcessEnv }) => {
  if (!enabled() || dirname(resolve(dir)) !== base() || !/^[0-9a-f-]{36}$/i.test(basename(dir))) throw new Error("Local bridge is not enabled for this directory")
  return spawn(process.execPath, [...args], { ...(options.cwd ? { cwd: options.cwd } : {}), env: options.env, stdio: ["ignore", "pipe", "pipe"], shell: false })
}
export type ManagedBridgeProcess = ReturnType<typeof startManagedBridge>
