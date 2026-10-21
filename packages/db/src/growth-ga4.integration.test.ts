// W8 GA4 persistence guards against a disposable PostgreSQL (TEST fixtures, no
// provider). Exercised through direct SQL on purpose: the claim that matters is
// that nothing can label an import as authenticated provider data without the
// binding, connection and claimed job behind it, that credentials are never
// stored in plaintext, and that evidence is append-only.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { GrowthMetricDefinitionInput } from "@openrecord/contracts"
import { GrowthRepository, GrowthRepositoryLive } from "./growth.js"
import { GrowthMeasurementRepository, GrowthMeasurementRepositoryLive } from "./growth-measurement.js"
import { RecordRepository, RecordRepositoryLive } from "./record.js"
import { migrate } from "./migrate.js"
import type { Session } from "./auth.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const P1 = "properties/424242"
const ga4Metric: GrowthMetricDefinitionInput = { conversionKind: "LEAD", label: "Leads", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", eventName: "generate_lead",
  countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: "424242" }
const CIPHER = `v1.k1.${"A".repeat(16)}.QUJD.${"B".repeat(22)}`
const hex64 = () => (randomUUID() + randomUUID()).replaceAll("-", "").slice(0, 64)
const READONLY = "https://www.googleapis.com/auth/analytics.readonly"

const suite = url ? describe : describe.skip
suite("GA4 measurement persistence and guards (disposable TEST fixtures)", () => {
  type Repos = GrowthRepository | GrowthMeasurementRepository | RecordRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Repos>
  const run = async <A, E>(fx: Effect.Effect<A, E, Repos>): Promise<A> => {
    const result = await Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    if (result._tag === "Left") throw result.left
    return result.right
  }
  beforeAll(async () => {
    await migrate(url); pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(GrowthRepositoryLive, GrowthMeasurementRepositoryLive, RecordRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))), scope)) as unknown as Context.Context<Repos>
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const fixture = async (metric: GrowthMetricDefinitionInput = ga4Metric) => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST ga4 guards') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`ga4g-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const profile = await run(Effect.flatMap(GrowthRepository, r => r.registerProduct(session, { name: "TEST Leads", websiteUrl: "https://leads.test", engagement: "CLIENT",
      category: "TEST", audience: "TEST", valueProposition: "TEST", goalStatement: "More leads", metric, idempotencyKey: randomUUID() })))
    const definitionId = profile.primaryGoal.metricDefinition.id
    const connectionId = String((await pool.query(`INSERT INTO growth_ga4_connections(account_id,google_subject,google_email,granted_scopes,status,connected_by_user_id)
      VALUES($1,$2,'agency@example.test',ARRAY['openid','email',$3],'ACTIVE',$4) RETURNING id`, [accountId, `sub${randomUUID().slice(0, 8)}`, READONLY, userId])).rows[0].id)
    return { session, accountId, userId, businessId: profile.businessId, definitionId, connectionId }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const bindSql = (f: F, over: { property?: string; event?: string; tz?: string; definitionId?: string; connectionId?: string } = {}) => pool.query(`INSERT INTO growth_ga4_bindings(business_id,connection_id,property,property_display_name,property_time_zone,metric_definition_id,event_name,provider_metric,created_by_user_id,request_key,request_fingerprint)
    VALUES($1,$2,$3,'TEST property',$4,$5,$6,'keyEvents',$7,$8,$9) RETURNING id`, [f.businessId, over.connectionId ?? f.connectionId, over.property ?? P1, over.tz ?? "UTC", over.definitionId ?? f.definitionId, over.event ?? "generate_lead", f.userId, randomUUID(), "c".repeat(64)])
  const jobSql = async (f: F, bindingId: string, claimed = true) => {
    const id = String((await pool.query("INSERT INTO growth_ga4_sync_jobs(binding_id,business_id,kind,date_start,date_end,requested_by_user_id) VALUES($1,$2,'BACKFILL','2026-09-01','2026-09-03',$3) RETURNING id", [bindingId, f.businessId, f.userId])).rows[0].id)
    if (claimed) await pool.query("UPDATE growth_ga4_sync_jobs SET status='CLAIMED', claimed_by='test', lease_expires_at=now()+interval '1 minute' WHERE id=$1", [id])
    return id
  }
  /** One transaction: an authenticated import, its observation (unless skipped) and one row. */
  const record = async (f: F, bindingId: string, jobId: string, over: { skipObservation?: boolean; event?: string; tz?: string; subject?: string } = {}) => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const importId = String((await client.query(`INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id)
        VALUES($1,$2,'GA4_AGGREGATE_EXPORT','AUTHENTICATED_PROVIDER_API','424242','2026-09-01','2026-09-03',$3,$4,$5,1,$6) RETURNING id`, [f.businessId, f.definitionId, over.tz ?? "UTC", `{"t":"${randomUUID()}"}`, randomUUID().replaceAll("-", "").padEnd(64, "0"), f.userId])).rows[0].id)
      if (!over.skipObservation) {
        const subject = over.subject ?? String((await client.query("SELECT google_subject FROM growth_ga4_connections WHERE id=$1", [f.connectionId])).rows[0].google_subject)
        await client.query(`INSERT INTO growth_ga4_observations(import_id,business_id,binding_id,connection_id,google_subject,job_id,property,event_name,provider_metric,metric_definition_id,metric_definition_version,time_zone,requested_start,requested_end,response_digest,subject_to_thresholding)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'keyEvents',$9,1,$10,'2026-09-01','2026-09-03',$11,false)`, [importId, f.businessId, bindingId, f.connectionId, subject, jobId, P1, over.event ?? "generate_lead", f.definitionId, over.tz ?? "UTC", "d".repeat(64)])
      }
      await client.query("INSERT INTO growth_metric_rows(import_id,business_id,day,value) VALUES($1,$2,'2026-09-02',4)", [importId, f.businessId])
      await client.query("COMMIT")
      return importId
    } catch (e) {
      await client.query("ROLLBACK")
      throw e
    } finally { client.release() }
  }

  it("never accepts provider provenance as a bare label", async () => {
    const f = await fixture()
    const bindingId = String((await bindSql(f)).rows[0].id)
    const jobId = await jobSql(f, bindingId)
    await expect(record(f, bindingId, jobId, { skipObservation: true })).rejects.toThrow(/without a ga4 observation/)
    await expect(record(f, bindingId, jobId, { event: "purchase" })).rejects.toThrow(/differs from its binding/)
    await expect(record(f, bindingId, jobId, { tz: "Asia/Makassar" })).rejects.toThrow(/timezone mismatch|time zone differs/)
    await expect(record(f, bindingId, jobId, { subject: "someone-else" })).rejects.toThrow(/active connection/)
    const ok = await record(f, bindingId, jobId)
    expect((await pool.query("SELECT provenance FROM growth_metric_imports WHERE id=$1", [ok])).rows[0].provenance).toBe("AUTHENTICATED_PROVIDER_API")
    // An unclaimed job cannot carry an observation.
    await pool.query("UPDATE growth_ga4_sync_jobs SET status='SUCCEEDED', claimed_by=NULL, lease_expires_at=NULL WHERE id=$1", [jobId])
    await expect(record(f, bindingId, jobId)).rejects.toThrow(/claimed job/)
    // Nor can a suspended connection.
    const next = await jobSql(f, bindingId)
    await pool.query("UPDATE growth_ga4_connections SET status='REAUTHORIZATION_REQUIRED', status_reason='AUTHORIZATION_REVOKED' WHERE id=$1", [f.connectionId])
    await expect(record(f, bindingId, next)).rejects.toThrow(/active connection/)
    // The CSV route cannot claim provider provenance.
    const csv = await Effect.runPromise(Effect.either(Effect.provide(Effect.flatMap(GrowthMeasurementRepository, m => m.importDaily(f.session, f.businessId, f.definitionId,
      { provenance: "AUTHENTICATED_PROVIDER_API" as "OPERATOR_SUPPLIED_EXPORT", dateStart: "2026-09-01", dateEnd: "2026-09-01", csv: "x" })), ctx)))
    expect(csv._tag === "Left" && (csv.left as { reason?: string }).reason).toBe("InvalidRequest")
    await expect(pool.query("INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id) VALUES($1,$2,'GA4_AGGREGATE_EXPORT','API','424242','2026-09-01','2026-09-01','UTC','x',$3,0,$4)",
      [f.businessId, f.definitionId, "e".repeat(64), f.userId])).rejects.toThrow(/provenance_check/)
  })

  it("binds only a matching GA4 definition through a connection of the same account", async () => {
    const f = await fixture()
    await expect(bindSql(f, { property: "properties/1" })).rejects.toThrow(/property differs/)
    await expect(bindSql(f, { event: "purchase" })).rejects.toThrow(/key event differs/)
    await expect(bindSql(f, { tz: "Asia/Makassar" })).rejects.toThrow(/time zone differs/)
    const csvBusiness = await fixture({ conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST", eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: null })
    await expect(bindSql(csvBusiness)).rejects.toThrow(/GA4 key-event count definition/)
    const other = await fixture()
    await expect(bindSql(f, { connectionId: other.connectionId })).rejects.toThrow(/another account/)
    // The bare id in the definition and the resource name name the same property.
    const first = String((await bindSql(f)).rows[0].id)
    const second = String((await bindSql(f)).rows[0].id)
    expect((await pool.query("SELECT growth_ga4_binding_active($1) AS a, growth_ga4_binding_active($2) AS b", [first, second])).rows[0]).toEqual({ a: false, b: true })
    // One open job per binding.
    await jobSql(f, second, false)
    await expect(jobSql(f, second, false)).rejects.toThrow(/growth_ga4_sync_jobs_one_open/)
  })

  it("stores ciphertext only, erases it on disconnect, and keeps state single use", async () => {
    const f = await fixture()
    await expect(pool.query("INSERT INTO growth_ga4_credentials(connection_id,account_id,refresh_ciphertext) VALUES($1,$2,'1//plaintext-refresh-token')", [f.connectionId, f.accountId])).rejects.toThrow(/refresh_ciphertext_check|check constraint/)
    await pool.query("INSERT INTO growth_ga4_credentials(connection_id,account_id,refresh_ciphertext,access_ciphertext,access_expires_at) VALUES($1,$2,$3,$3,now()+interval '1 hour')", [f.connectionId, f.accountId, CIPHER])
    await pool.query("UPDATE growth_ga4_connections SET status='DISCONNECTED', disconnected_at=now() WHERE id=$1", [f.connectionId])
    expect((await pool.query("SELECT refresh_ciphertext, access_ciphertext FROM growth_ga4_credentials WHERE connection_id=$1", [f.connectionId])).rows[0]).toEqual({ refresh_ciphertext: null, access_ciphertext: null })
    // Reactivation needs a new authorization.
    await expect(pool.query("UPDATE growth_ga4_connections SET status='ACTIVE', disconnected_at=NULL WHERE id=$1", [f.connectionId])).rejects.toThrow(/new authorization/)
    await expect(pool.query("DELETE FROM growth_ga4_connections WHERE id=$1", [f.connectionId])).rejects.toThrow(/keep their history/)
    const state = String((await pool.query("INSERT INTO growth_ga4_oauth_states(account_id,user_id,business_id,state_sha256,verifier_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes') RETURNING id",
      [f.accountId, f.userId, f.businessId, hex64(), CIPHER])).rows[0].id)
    await pool.query("UPDATE growth_ga4_oauth_states SET consumed_at=now() WHERE id=$1", [state])
    await expect(pool.query("UPDATE growth_ga4_oauth_states SET consumed_at=now() WHERE id=$1", [state])).rejects.toThrow(/single use/)
    const outsider = await fixture()
    await expect(pool.query("INSERT INTO growth_ga4_oauth_states(account_id,user_id,business_id,state_sha256,verifier_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",
      [f.accountId, outsider.userId, f.businessId, hex64(), CIPHER])).rejects.toThrow(/outside scope/)
  })

  it("keeps observations, bindings, runs and connection events append-only", async () => {
    const f = await fixture()
    const bindingId = String((await bindSql(f)).rows[0].id)
    const jobId = await jobSql(f, bindingId)
    const importId = await record(f, bindingId, jobId)
    await expect(pool.query("UPDATE growth_ga4_observations SET response_digest=$2 WHERE import_id=$1", [importId, "0".repeat(64)])).rejects.toThrow()
    await expect(pool.query("DELETE FROM growth_ga4_observations WHERE import_id=$1", [importId])).rejects.toThrow()
    await expect(pool.query("UPDATE growth_ga4_bindings SET property='properties/9' WHERE id=$1", [bindingId])).rejects.toThrow()
    await expect(pool.query("UPDATE growth_metric_rows SET value=99 WHERE import_id=$1", [importId])).rejects.toThrow()
    await pool.query("INSERT INTO growth_ga4_sync_runs(job_id,binding_id,business_id,attempt,outcome,import_id,response_digest,days_reported) VALUES($1,$2,$3,1,'RECORDED',$4,$5,1)", [jobId, bindingId, f.businessId, importId, "d".repeat(64)])
    await expect(pool.query("DELETE FROM growth_ga4_sync_runs WHERE job_id=$1", [jobId])).rejects.toThrow()
    await expect(pool.query("INSERT INTO growth_ga4_sync_runs(job_id,binding_id,business_id,attempt,outcome,error_code) VALUES($1,$2,$3,2,'RECORDED','X')", [jobId, bindingId, f.businessId])).rejects.toThrow(/check/)
    await pool.query("UPDATE growth_ga4_sync_jobs SET status='SUCCEEDED', claimed_by=NULL, lease_expires_at=NULL WHERE id=$1", [jobId])
    await expect(pool.query("UPDATE growth_ga4_sync_jobs SET status='QUEUED' WHERE id=$1", [jobId])).rejects.toThrow(/finished/)
    await expect(pool.query("UPDATE growth_ga4_sync_jobs SET date_end='2026-12-01' WHERE id=$1", [jobId])).rejects.toThrow(/immutable/)
  })
})
