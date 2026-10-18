import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process"
import { fileURLToPath } from "node:url"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { configuredAgentModel } from "./agent-model.js"

export const readStartupGit = () => {
  try {
    // Resolve this module's checkout even if the API was launched from another directory.
    const options = { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] } satisfies ExecFileSyncOptionsWithStringEncoding
    const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim()
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("invalid commit")
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], options).trim().length > 0
    return { commitSha: commit, shortCommitSha: commit.slice(0, 12), dirtyAtStartup: dirty }
  } catch {
    // No reliable dirty-state claim is possible without git; null marks unavailable metadata.
    return { commitSha: null, shortCommitSha: null, dirtyAtStartup: null }
  }
}

// Module initialization captures startup state once, never the caller's current checkout.
const startupGit = readStartupGit()

export const runtimeDiagnostic = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // Older databases have no ledger until the updated migrator is run. Unknown stays null.
  const ledger = yield* sql<{ present: boolean }>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`
  const migrations = ledger[0]?.present
    ? yield* sql<{ filename: string }>`SELECT filename FROM public.schema_migrations ORDER BY filename DESC LIMIT 1`
    : []
  const latest = migrations[0]?.filename ?? null
  const agentConfigured = yield* configuredAgentModel.pipe(Effect.isSuccess)
  return {
    ...startupGit,
    latestMigration: latest !== null && /^\d{4}_[a-z0-9_]+\.sql$/.test(latest) ? latest : null,
    agentConfigured,
  }
})
