// Narrow local-mode filesystem capability. Only server-configured locations
// are used; credential contents never leave this module.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

const enabled = () => /^(1|true|on)$/i.test(process.env["OPENRECORD_LOCAL_BRIDGE"] ?? "")
const base = () => resolve(process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] ?? join(homedir(), ".openrecord", "app"))
const homeAllowed = (dir: string) => enabled() && dirname(resolve(dir)) === base() && /^[0-9a-f-]{36}$/i.test(basename(dir))
const safeHome = (dir: string) => {
  if (!homeAllowed(dir)) return false
  try { return !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory() } catch { return false }
}
const readState = (dir: string, name: "bridge.json" | "bridge.lock"): string | null => {
  if (!safeHome(dir)) return null
  let fd: number | undefined
  try {
    fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65536) return null
    return readFileSync(fd, "utf8")
  } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
}
export const managedBridgeId = (dir: string): string | null => {
  try {
    const value: unknown = JSON.parse(readState(dir, "bridge.json") ?? "null")
    if (typeof value !== "object" || value === null || !("bridgeId" in value)) return null
    return typeof value.bridgeId === "string" && /^[0-9a-f-]{36}$/i.test(value.bridgeId) ? value.bridgeId : null
  } catch { return null }
}
export const managedBridgePid = (dir: string): number | null => {
  const value = Number(readState(dir, "bridge.lock"))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
export const managedBridgeUsers = (): string[] => {
  if (!enabled()) return []
  try { return readdirSync(base()).filter(userId => safeHome(join(base(), userId))) } catch { return [] }
}
export const prepareManagedBridgeHome = (dir: string): void => {
  if (!homeAllowed(dir)) throw new Error("Invalid managed bridge directory")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!safeHome(dir)) throw new Error("Invalid managed bridge directory")
}
export const localBridgeProgramExists = (file: string): boolean => enabled() && existsSync(file)
