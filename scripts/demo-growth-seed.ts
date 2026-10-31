// Demo growth data: attaches a growth profile + goal to the demo account's
// Northstar Software business (replayed via a fixed idempotency key when
// unchanged) and imports ~30 days of synthetic-fixture daily measurements
// through the real W3 import path, so the goal trend, health strip and the
// weekly brief's chart all render with sample data. Re-running is idempotent
// within a day: CSV values are a deterministic function of each calendar day,
// and overlapping imports with equal values never create conflicts.
// Run: DATABASE_URL=... pnpm --filter @openrecord/worker exec tsx ../../scripts/demo-growth-seed.ts
import { Context, Effect, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import {
  GrowthMeasurementRepository,
  GrowthMeasurementRepositoryLive,
  GrowthRepositoriesLive,
  GrowthRepository,
  type GrowthProfile,
  type GrowthSeries,
  type Session,
} from "@openrecord/db"
import { PgClient } from "@effect/sql-pg"

const DEMO_EMAIL = "demo@northstar.test"
const DEMO_BUSINESS = "Northstar Software"
// Stable request identity so re-runs replay the same profile save instead of
// piling up new goal versions (the payload is constant).
const PROFILE_KEY = "a1d2e6f0-4f21-4a6d-9d0a-2f6a4f8c1b01"

const url = process.env["DATABASE_URL"]
if (!url) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

// Deterministic per-calendar-day value: a gentle upward "launch ramp" from
// late September with a weekend dip, so replays never conflict.
const valueFor = (day: string): number => {
  const ms = Date.parse(`${day}T00:00:00Z`)
  const epochDay = Math.floor(ms / 86_400_000)
  const sinceLaunch = Math.max(0, epochDay - Math.floor(Date.parse("2026-09-20T00:00:00Z") / 86_400_000))
  const weekday = new Date(ms).getUTCDay()
  const base = 12 + sinceLaunch * 0.9
  const wobble = 3 * Math.sin(epochDay / 3.5)
  const weekendDip = weekday === 0 || weekday === 6 ? -4 : 0
  return Math.max(0, Math.round(base + wobble + weekendDip))
}

// Days inside the declared range without a row stay MISSING; every ninth day
// is skipped so the charts show a few reproducible gaps.
const isGap = (day: string): boolean => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) % 9 === 0

const isoDays = (start: string, end: string): string[] => {
  const out: string[] = []
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

// UTC calendar day, n days before today; imports stop at yesterday.
const isoDay = (offsetFromToday: number): string =>
  new Date(Date.now() - offsetFromToday * 86_400_000).toISOString().slice(0, 10)

const main = async (): Promise<void> => {
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  let exit = 0
  try {
    const user = (await db.query(
      `SELECT u.id AS user_id, au.account_id FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.email = $1 LIMIT 1`,
      [DEMO_EMAIL],
    )).rows[0]
    if (!user) throw new Error(`demo user not found: ${DEMO_EMAIL} (run db:seed:demo first)`)
    const business = (await db.query(
      `SELECT id FROM businesses WHERE account_id = $1 AND name = $2 LIMIT 1`,
      [user["account_id"], DEMO_BUSINESS],
    )).rows[0]
    if (!business) throw new Error(`business not found: ${DEMO_BUSINESS}`)
    const session: Session = { userId: String(user["user_id"]), accountId: String(user["account_id"]) }
    const businessId = String(business["id"])

    const repos = Layer.mergeAll(GrowthRepositoriesLive, GrowthMeasurementRepositoryLive).pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
    )
    const scope = await Effect.runPromise(Scope.make())
    const ctx = await Effect.runPromise(Layer.buildWithScope(repos, scope)) as Context.Context<
      GrowthRepository | GrowthMeasurementRepository
    >
    const program = Effect.gen(function*() {
      const repo = yield* GrowthRepository
      const profile: GrowthProfile = yield* repo.saveProfile(session, businessId, {
        category: "Software",
        audience: "Small local businesses in North America who manage online bookings by hand",
        valueProposition:
          "Bookable visits AI assistants can quote and verify: prices, hours and guarantees that stay true everywhere they are asked.",
        goalStatement: "Grow trial signups from AI assistants and the website",
        metric: {
          conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "OPERATOR_AGGREGATE_EXPORT",
          sourceIdentity: "Manual daily export", eventName: null, countingSemantics: "EVENT_COUNT",
          unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: null,
        },
        idempotencyKey: PROFILE_KEY,
      })
      const definitionId = profile.primaryGoal.metricDefinition.id
      const measure = yield* GrowthMeasurementRepository
      const start = isoDay(30)
      const end = isoDay(1)
      const csv = `date,value\n${isoDays(start, end).filter(d => !isGap(d)).map(d => `${d},${valueFor(d)}`).join("\n")}\n`
      const result = yield* measure.importDaily(session, businessId, definitionId, {
        provenance: "SYNTHETIC_FIXTURE", dateStart: start, dateEnd: end, csv,
      })
      const series: GrowthSeries = yield* measure.series(session.accountId, businessId, definitionId, start, end)
      return { profile, result, series }
    })
    const out = await Effect.runPromise(Effect.provide(program, ctx))
    const last7 = out.series.days.slice(-7).filter(d => d.status === "OK" || d.status === "CONFLICT")
    console.log(`profile: goal "${out.profile.primaryGoal.statement}", metric "${out.profile.primaryGoal.metricDefinition.label}" (definition ${out.profile.primaryGoal.metricDefinition.id})`)
    console.log(`import: ${out.result.import.provenance} ${out.result.import.dateStart}..${out.result.import.dateEnd}` +
      ` rows=${out.result.coverage.daysPresent}/${out.result.coverage.daysInRange} missing=${out.result.coverage.missingDays}` +
      `${out.result.replayed ? " (replayed)" : ""}`)
    console.log(`series: ${out.series.metricLabel} · last 7 days reported ${last7.length}/7`)
    console.log(`demo growth data ready for ${DEMO_BUSINESS}`)
  } catch (e) {
    console.error(String(e))
    exit = 1
  } finally {
    await db.end()
  }
  process.exit(exit)
}

void main()
