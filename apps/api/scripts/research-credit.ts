// Operator tool for research credit: the prepaid balance that pays for
// provider calls served on OpenRecord's own provider accounts.
//
//   pnpm --filter @openrecord/api research:credit -- --account <uuid>                          show balance, 30-day spend and recent calls
//   pnpm --filter @openrecord/api research:credit -- --account <uuid> --add 5.00 --note "..."   add $5.00 of credit
//
// DATABASE_URL must point at the server's database. Amounts are dollars with
// up to six decimals; the ledger stores micro-dollars.
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { addCredit, balanceOf, recentCalls, spendSince, usd } from "../src/research/endpoints/metering.js"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const account = flag("account")
const add = flag("add")
const url = process.env["DATABASE_URL"]
if (!url || !account || !/^[0-9a-f-]{36}$/i.test(account)) {
  console.error("usage: research:credit -- --account <uuid> [--add <dollars> --note <text>]  (DATABASE_URL required)")
  process.exit(2)
}
const micro = add === undefined ? null : Math.round(Number(add) * 1_000_000)
if (micro !== null && (!Number.isSafeInteger(micro) || micro <= 0)) { console.error("--add must be a positive dollar amount"); process.exit(2) }

const program = Effect.gen(function*() {
  if (micro !== null) yield* addCredit(account, micro, flag("note") ?? "operator top-up", null)
  const balance = yield* balanceOf(account)
  const spend = yield* spendSince(account, 30)
  const calls = yield* recentCalls(account, null, 10)
  console.log(`balance ${usd(balance)}${micro !== null ? ` (added ${usd(micro)})` : ""}`)
  console.log(`last 30 days: ${spend.calls} calls, ${spend.paidCalls} paid, ${usd(spend.spentMicro)} spent`)
  for (const c of calls) console.log(`  ${c.startedAt}  ${c.endpoint.padEnd(28)} ${c.credentialSource.padEnd(8)} ${c.status.padEnd(9)} ${usd(c.costMicro)}${c.refunded ? " refunded" : ""}`)
})

await Effect.runPromise(program.pipe(Effect.provide(Layer.orDie(PgClient.layer({ url: Redacted.make(url) })))))
