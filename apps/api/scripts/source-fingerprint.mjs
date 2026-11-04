import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

// Launcher-only: hosted request handlers never inspect the filesystem.
const root = fileURLToPath(new URL("../../../", import.meta.url))
const hash = createHash("sha256")
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (/\.(?:ts|js|json)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
      hash.update(relative(root, path)); hash.update("\0"); hash.update(readFileSync(path)); hash.update("\0")
    }
  }
}
visit(resolve(root, "apps/api/src"))
visit(resolve(root, "packages/contracts/src"))
process.stdout.write(hash.digest("hex"))
