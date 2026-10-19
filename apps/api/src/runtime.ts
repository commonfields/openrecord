import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { configuredAgentModel } from "./agent-model.js"

// Hosted code may not start subprocesses or import fs (architecture guards),
// so the API does not inspect its checkout. The launcher states what it
// started: `pnpm dev` passes OPENRECORD_BUILD_COMMIT and OPENRECORD_BUILD_DIRTY
// from git (see apps/api/package.json); anything missing or malformed is
// reported as unknown (null), never guessed.
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

export const readStartupGit = (env: Record<string, string | undefined> = process.env) => {
  const flag = env["OPENRECORD_BUILD_DIRTY"]?.trim()
  const dirtyAtStartup = flag === "true" ? true : flag === "false" ? false : null
  const commit = env["OPENRECORD_BUILD_COMMIT"]?.trim().toLowerCase() ?? ""
  return COMMIT.test(commit)
    ? { commitSha: commit, shortCommitSha: commit.slice(0, 12), dirtyAtStartup }
    : { commitSha: null, shortCommitSha: null, dirtyAtStartup }
}


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
    // The launch environment is fixed for the process, so this is startup state.
    ...readStartupGit(),
    latestMigration: latest !== null && /^\d{4}_[a-z0-9_]+\.sql$/.test(latest) ? latest : null,
    agentConfigured,
  }
})
