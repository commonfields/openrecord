// Vitest global setup for the suites that write to PostgreSQL. Integration
// tests create accounts, businesses and queued agent work; pointed at the
// local development database they leave that behind, and a running worker
// then spends model calls on fake accounts. So a suite refuses to start when
// either database variable names the dev database. Use a throwaway database
// instead: scripts/test-db.sh creates one, migrates it, runs the command and
// drops it.
const DEV_DATABASES = new Set(["openrecord_dev", ...(process.env["OPENRECORD_DEV_DATABASE"] ? [process.env["OPENRECORD_DEV_DATABASE"]] : [])])

/** The database a connection URL names, or null when it names none. */
export const databaseName = (url: string): string | null => {
  try {
    const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""))
    return name || null
  } catch {
    return null
  }
}

/** Why the environment must not run database tests, or null when it may. */
export const refusal = (env: Record<string, string | undefined>): string | null => {
  for (const key of ["TEST_DATABASE_URL", "DATABASE_URL"]) {
    const name = env[key] ? databaseName(env[key]!) : null
    if (name && DEV_DATABASES.has(name)) {
      return `${key} points at the development database "${name}". Integration tests write accounts and queued agent work there. ` +
        `Run them against a throwaway database: scripts/test-db.sh pnpm --filter <package> test`
    }
  }
  return null
}

export default function setup() {
  const reason = refusal(process.env)
  if (reason) throw new Error(reason)
}
