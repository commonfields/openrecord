import { defineConfig } from "vitest/config"
// Integration files share one database (and one re-runs migrations), so
// files run serially.
// Refuses to run against the development database (packages/config/src/database-guard.ts).
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 30000, fileParallelism: false, globalSetup: ["../../packages/config/src/database-guard.ts"] } })
