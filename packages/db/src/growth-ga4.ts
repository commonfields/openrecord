// W8 GA4 measurement repository: connections (who authorized read access),
// single-use OAuth states, bindings (which property and key event measure which
// metric definition), durable sync jobs and the recording of one provider
// observation as an authenticated W3 import. The 0035 guards carry the same
// rules; this layer adds request identities, typed refusals and the
// unchanged-observation decision. It stores ciphertext only: encryption and
// every provider call happen at the edge (API and worker).
import { createHash } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  decodeRouteId, ga4LatestCompleteDay, ga4PropertyMatchesRef, ga4ShiftDay, GA4_STALE_AFTER_HOURS, Ga4ConnectionStatus, Ga4JobStatus, Ga4RunOutcome, Ga4SyncKind,
  type BindGa4Property, type Ga4Binding, type Ga4BindingHealth, type Ga4Connection, type Ga4SyncJob, type Ga4SyncRun, type RequestGa4Sync,
} from "@openrecord/contracts"
import { decodeRow, iso, type RowDecodeError } from "./row-codecs.js"
import { GrowthMeasurementRepository } from "./growth-measurement.js"
import type { Session } from "./auth.js"

export class GrowthGa4Refused extends Data.TaggedError("GrowthGa4Refused")<{ readonly reason: string }> {}
export type GrowthGa4Effect<A> = Effect.Effect<A, SqlError | RowDecodeError | GrowthGa4Refused>

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const ConnectionDoc = Schema.Struct({
  id: Schema.UUID, accountId: Schema.UUID, googleEmail: Schema.String, grantedScopes: Schema.Array(Schema.String),
  status: Ga4ConnectionStatus, statusReason: Schema.NullOr(Schema.String), connectedByUserId: Schema.UUID, createdAt: Schema.String,
  lastAuthorizedAt: Schema.String, disconnectedAt: Schema.NullOr(Schema.String), revocationConfirmed: Schema.NullOr(Schema.Boolean),
})
const BindingDoc = Schema.Struct({
  id: Schema.UUID, businessId: Schema.UUID, connectionId: Schema.UUID, property: Schema.String, propertyDisplayName: Schema.String,
  propertyTimeZone: Schema.String, metricDefinitionId: Schema.UUID, metricDefinitionVersion: Schema.Int, eventName: Schema.String,
  providerMetric: Schema.Literal("keyEvents"), keyEventCountingMethod: Schema.NullOr(Schema.String), createdByUserId: Schema.UUID, createdAt: Schema.String,
})

export interface Ga4Credentials {
  readonly connectionId: string
  readonly accountId: string
  readonly googleSubject: string
  readonly status: Ga4ConnectionStatus
  readonly refreshCiphertext: string | null
  readonly accessCiphertext: string | null
  readonly accessExpiresAt: number | null
}
export interface Ga4SealedTokens { readonly refreshCiphertext: string | null; readonly accessCiphertext: string; readonly accessExpiresAt: number }
export interface Ga4AuthorizationGrant {
  readonly googleSubject: string
  readonly googleEmail: string
  readonly grantedScopes: ReadonlyArray<string>
  /** Called once the connection id is known: ciphertext is bound to it. */
  readonly seal: (connectionId: string) => Ga4SealedTokens
}
export interface Ga4ClaimedJob {
  readonly id: string
  readonly bindingId: string
  readonly businessId: string
  readonly kind: Ga4SyncKind
  readonly dateStart: string
  readonly dateEnd: string
  readonly attemptCount: number
}
export interface Ga4JobWork {
  readonly job: Ga4ClaimedJob
  readonly binding: Ga4Binding
  readonly bindingActive: boolean
  readonly accountId: string
  readonly credentials: Ga4Credentials
  readonly importedByUserId: string
  readonly importerIsMember: boolean
}
export interface Ga4ObservationInput {
  /** Canonical envelope of request, normalized response and the provider body, exactly as stored. */
  readonly rawText: string
  readonly responseDigest: string
  readonly rows: ReadonlyArray<{ readonly day: string; readonly value: number }>
  readonly subjectToThresholding: boolean
  readonly quota: Record<string, unknown> | null
}
export interface Ga4RecordResult { readonly outcome: "RECORDED" | "UNCHANGED"; readonly importId: string }

const guardReasons: ReadonlyArray<{ readonly needle: string; readonly reason: string }> = [
  { needle: "ga4 connection belongs to another account", reason: "Ga4ConnectionNotFound" },
  { needle: "ga4 connection is not active", reason: "Ga4ConnectionNotActive" },
  { needle: "ga4 binding requires a GA4 key-event count definition", reason: "MetricDefinitionNotGa4" },
  { needle: "ga4 binding property differs", reason: "PropertyDiffersFromDefinition" },
  { needle: "ga4 binding key event differs", reason: "KeyEventDiffersFromDefinition" },
  { needle: "ga4 binding time zone differs", reason: "PropertyTimeZoneDiffersFromDefinition" },
  { needle: "ga4 binding is no longer active", reason: "BindingInactive" },
  { needle: "binding's active connection", reason: "Ga4ConnectionNotActive" },
  { needle: "import outside scope", reason: "BindingAuthorNotMember" },
  { needle: "growth_ga4_sync_jobs_one_open", reason: "SyncAlreadyOpen" },
]
const mapGuard = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, SqlError | GrowthGa4Refused, R> => effect.pipe(
  Effect.mapError(e => {
    const cause = (e as unknown as { cause?: { message?: string; constraint?: string } }).cause
    const message = `${cause?.message ?? ""} ${cause?.constraint ?? ""}`
    for (const { needle, reason } of guardReasons) if (message.includes(needle)) return new GrowthGa4Refused({ reason })
    return e
  }))

const jobOf = (r: Record<string, unknown>): Ga4SyncJob => ({
  id: String(r["id"]), bindingId: String(r["binding_id"]), kind: Schema.decodeUnknownSync(Ga4SyncKind)(r["kind"]),
  dateStart: String(r["date_start"]), dateEnd: String(r["date_end"]), status: Schema.decodeUnknownSync(Ga4JobStatus)(r["status"]),
  attemptCount: Number(r["attempt_count"]), lastError: r["last_error"] == null ? null : String(r["last_error"]),
  notBefore: iso(r["not_before"] as Date | string), createdAt: iso(r["created_at"] as Date | string), updatedAt: iso(r["updated_at"] as Date | string),
})
const runOf = (r: Record<string, unknown>): Ga4SyncRun => ({
  id: String(r["id"]), jobId: String(r["job_id"]), attempt: Number(r["attempt"]), outcome: Schema.decodeUnknownSync(Ga4RunOutcome)(r["outcome"]),
  errorCode: r["error_code"] == null ? null : String(r["error_code"]), importId: r["import_id"] == null ? null : String(r["import_id"]),
  responseDigest: r["response_digest"] == null ? null : String(r["response_digest"]), daysReported: r["days_reported"] == null ? null : Number(r["days_reported"]),
  finishedAt: iso(r["finished_at"] as Date | string),
})
const JOB_COLUMNS = "id, binding_id, kind, date_start::text AS date_start, date_end::text AS date_end, status, attempt_count, last_error, not_before, created_at, updated_at"

export class GrowthGa4Repository extends Context.Tag("GrowthGa4Repository")<GrowthGa4Repository, {
  // connections (account-scoped)
  readonly connections: (accountId: string) => GrowthGa4Effect<ReadonlyArray<Ga4Connection>>
  readonly connection: (accountId: string, connectionId: string) => GrowthGa4Effect<Ga4Connection>
  readonly startAuthorization: (session: Session, input: { readonly businessId: string; readonly connectionId: string | null; readonly stateSha256: string; readonly verifierCiphertext: string; readonly ttlSeconds: number; readonly returnTo?: "MEASUREMENT" | "CHANNELS" | undefined }) => GrowthGa4Effect<void>
  /** Single use. Refused for an unknown, expired, reused, or another user's state. */
  readonly consumeAuthorization: (session: Session, stateSha256: string) => GrowthGa4Effect<{ readonly businessId: string; readonly connectionId: string | null; readonly verifierCiphertext: string; readonly stateId: string; readonly returnTo: "MEASUREMENT" | "CHANNELS" }>
  readonly saveAuthorization: (session: Session, expectedConnectionId: string | null, grant: Ga4AuthorizationGrant) => GrowthGa4Effect<Ga4Connection>
  readonly credentials: (connectionId: string) => GrowthGa4Effect<Ga4Credentials>
  readonly storeAccessToken: (connectionId: string, accessCiphertext: string, accessExpiresAt: number) => GrowthGa4Effect<void>
  /** Authorization failed at the provider: stop using the connection until it is re-authorized. */
  readonly suspend: (connectionId: string, reason: string) => GrowthGa4Effect<void>
  readonly disconnect: (session: Session, connectionId: string, revocationConfirmed: boolean) => GrowthGa4Effect<Ga4Connection>
  // bindings (business-scoped)
  readonly bindings: (accountId: string, businessId: string) => GrowthGa4Effect<ReadonlyArray<Ga4Binding & { readonly active: boolean }>>
  readonly bind: (session: Session, businessId: string, input: BindGa4Property, verified: { readonly propertyDisplayName: string; readonly propertyAccount: string | null; readonly propertyTimeZone: string; readonly keyEventCountingMethod: string | null }) => GrowthGa4Effect<{ readonly binding: Ga4Binding; readonly replayed: boolean }>
  readonly health: (accountId: string, businessId: string, bindingId: string, nowMs: number) => GrowthGa4Effect<Ga4BindingHealth>
  /** Checks a binding request against the stored definition before any provider call. Returns the definition's time zone. */
  readonly checkBindable: (accountId: string, businessId: string, input: BindGa4Property) => GrowthGa4Effect<{ readonly timeZone: string }>
  // jobs
  readonly requestSync: (session: Session, businessId: string, bindingId: string, input: RequestGa4Sync) => GrowthGa4Effect<{ readonly job: Ga4SyncJob; readonly replayed: boolean }>
  /** Queues bounded scheduled refreshes for active bindings with no open job and no scheduled job in the interval. Returns how many. */
  readonly scheduleDue: (opts: { readonly intervalHours: number; readonly refreshDays: number; readonly limit: number; readonly onlyBindings?: ReadonlyArray<string> }) => GrowthGa4Effect<number>
  readonly claimJob: (workerId: string, leaseSeconds: number, onlyBindings?: ReadonlyArray<string>) => GrowthGa4Effect<Ga4ClaimedJob | null>
  readonly work: (job: Ga4ClaimedJob) => GrowthGa4Effect<Ga4JobWork>
  readonly retryJob: (job: Ga4ClaimedJob, workerId: string, delaySeconds: number, code: string, quota?: Record<string, unknown> | null) => GrowthGa4Effect<void>
  readonly failJob: (job: Ga4ClaimedJob, workerId: string, code: string) => GrowthGa4Effect<void>
  /** One transaction: either a new authenticated import with its observation and rows, or an UNCHANGED confirmation; then the job succeeds. */
  readonly recordObservation: (job: Ga4ClaimedJob, workerId: string, input: Ga4ObservationInput) => GrowthGa4Effect<Ga4RecordResult>
}>() {}

export const GrowthGa4RepositoryLive = Layer.effect(GrowthGa4Repository, Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const measurement = yield* GrowthMeasurementRepository
  const refuse = (reason: string) => Effect.fail(new GrowthGa4Refused({ reason }))
  const ids = (...values: ReadonlyArray<string>) => values.some(v => decodeRouteId(v)._tag === "Left") ? refuse("InvalidRequest") : Effect.void
  const member = (session: Session) => Effect.gen(function*() {
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("Ga4ConnectionNotFound")
  })
  const business = (accountId: string, businessId: string) => Effect.gen(function*() {
    yield* ids(businessId)
    const rows = yield* sql`SELECT b.id FROM businesses b JOIN record_profiles r ON r.business_id=b.id WHERE b.id=${businessId} AND b.account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const readConnection = (accountId: string, connectionId: string) => Effect.gen(function*() {
    yield* ids(connectionId)
    const rows = yield* sql`SELECT document FROM growth_ga4_connection_documents WHERE id=${connectionId} AND account_id=${accountId}`
    if (!rows[0]) return yield* refuse("Ga4ConnectionNotFound")
    return yield* decodeRow(ConnectionDoc, "growth_ga4_connections", rows[0]["document"])
  })
  const readBinding = (businessId: string, bindingId: string) => Effect.gen(function*() {
    yield* ids(bindingId)
    const rows = yield* sql`SELECT document, growth_ga4_binding_active(id) AS active FROM growth_ga4_binding_documents WHERE id=${bindingId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("Ga4BindingNotFound")
    return { binding: yield* decodeRow(BindingDoc, "growth_ga4_bindings", rows[0]["document"]), active: rows[0]["active"] === true }
  })
  const event = (connectionId: string, accountId: string, kind: string, userId: string | null, detail: Record<string, unknown>) =>
    sql`INSERT INTO growth_ga4_connection_events(connection_id,account_id,kind,user_id,detail) VALUES(${connectionId},${accountId},${kind},${userId},${JSON.stringify(detail)}::jsonb)`
  const runRow = (job: Ga4ClaimedJob, outcome: string, fields: { errorCode?: string | null; importId?: string | null; responseDigest?: string | null; daysReported?: number | null; quota?: Record<string, unknown> | null }) =>
    sql`INSERT INTO growth_ga4_sync_runs(job_id,binding_id,business_id,attempt,outcome,error_code,import_id,response_digest,days_reported,quota)
      VALUES(${job.id},${job.bindingId},${job.businessId},${job.attemptCount},${outcome},${fields.errorCode ?? null},${fields.importId ?? null},${fields.responseDigest ?? null},${fields.daysReported ?? null},
        ${fields.quota ? JSON.stringify(fields.quota) : null}::jsonb)`
  /** The job must still be ours: a worker whose lease expired and was reclaimed records nothing. */
  const lockOwnJob = (job: Ga4ClaimedJob, workerId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT status, claimed_by FROM growth_ga4_sync_jobs WHERE id=${job.id} FOR UPDATE`
    if (rows[0]?.["status"] !== "CLAIMED" || rows[0]?.["claimed_by"] !== workerId) return yield* refuse("JobLeaseLost")
  })

  return {
    connections: accountId => Effect.gen(function*() {
      const rows = yield* sql`SELECT document FROM growth_ga4_connection_documents WHERE account_id=${accountId} ORDER BY created_at, id`
      return yield* Effect.forEach(rows, r => decodeRow(ConnectionDoc, "growth_ga4_connections", r["document"]))
    }),
    connection: readConnection,
    startAuthorization: (session, input) => Effect.gen(function*() {
      yield* member(session)
      yield* business(session.accountId, input.businessId)
      if (input.connectionId !== null) yield* readConnection(session.accountId, input.connectionId)
      yield* sql`INSERT INTO growth_ga4_oauth_states(account_id,user_id,business_id,connection_id,state_sha256,verifier_ciphertext,expires_at,return_to)
        VALUES(${session.accountId},${session.userId},${input.businessId},${input.connectionId},${input.stateSha256},${input.verifierCiphertext},now()+${input.ttlSeconds}*interval '1 second',${input.returnTo ?? "MEASUREMENT"})`
    }),
    consumeAuthorization: (session, stateSha256) => sql.withTransaction(Effect.gen(function*() {
      if (!/^[a-f0-9]{64}$/.test(stateSha256)) return yield* refuse("OAuthStateInvalid")
      const rows = yield* sql`SELECT id, account_id, user_id, business_id, connection_id, verifier_ciphertext, consumed_at, return_to, expires_at < now() AS expired
        FROM growth_ga4_oauth_states WHERE state_sha256=${stateSha256} FOR UPDATE`
      const row = rows[0]
      // Another user's or account's state is indistinguishable from an unknown one.
      if (!row || row["account_id"] !== session.accountId || row["user_id"] !== session.userId) return yield* refuse("OAuthStateInvalid")
      if (row["consumed_at"] != null) return yield* refuse("OAuthStateReused")
      yield* sql`UPDATE growth_ga4_oauth_states SET consumed_at=now() WHERE id=${String(row["id"])}`
      if (row["expired"] === true) return yield* Effect.fail(new GrowthGa4Refused({ reason: "OAuthStateExpired" }))
      return { stateId: String(row["id"]), businessId: String(row["business_id"]), connectionId: row["connection_id"] == null ? null : String(row["connection_id"]), verifierCiphertext: String(row["verifier_ciphertext"]),
        returnTo: row["return_to"] === "CHANNELS" ? "CHANNELS" as const : "MEASUREMENT" as const }
    }).pipe(
      // An expired state is consumed too: commit the consumption, then refuse.
      Effect.catchIf((e): e is GrowthGa4Refused => e instanceof GrowthGa4Refused && e.reason === "OAuthStateExpired", e => Effect.gen(function*() {
        yield* sql`UPDATE growth_ga4_oauth_states SET consumed_at=now() WHERE state_sha256=${stateSha256} AND consumed_at IS NULL`
        return yield* Effect.fail(e)
      })))),
    saveAuthorization: (session, expectedConnectionId, grant) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session)
      const existing = yield* sql`SELECT id, status FROM growth_ga4_connections WHERE account_id=${session.accountId} AND google_subject=${grant.googleSubject} FOR UPDATE`
      if (expectedConnectionId !== null && existing[0]?.["id"] !== expectedConnectionId) return yield* refuse("Ga4IdentityMismatch")
      const scopes = [...grant.grantedScopes].sort()
      let connectionId: string
      if (existing[0]) {
        connectionId = String(existing[0]["id"])
        yield* sql`UPDATE growth_ga4_connections SET status='ACTIVE', status_reason=NULL, google_email=${grant.googleEmail}, granted_scopes=${scopes}::text[],
          last_authorized_at=clock_timestamp(), disconnected_at=NULL, revocation_confirmed=NULL WHERE id=${connectionId}`
        yield* event(connectionId, session.accountId, "REAUTHORIZED", session.userId, { previousStatus: existing[0]["status"] })
      } else {
        const inserted = yield* sql`INSERT INTO growth_ga4_connections(account_id,google_subject,google_email,granted_scopes,status,connected_by_user_id)
          VALUES(${session.accountId},${grant.googleSubject},${grant.googleEmail},${scopes}::text[],'ACTIVE',${session.userId}) RETURNING id`
        connectionId = String(inserted[0]!["id"])
        yield* event(connectionId, session.accountId, "CONNECTED", session.userId, {})
      }
      const sealed = grant.seal(connectionId)
      const current = yield* sql`SELECT refresh_ciphertext FROM growth_ga4_credentials WHERE connection_id=${connectionId} FOR UPDATE`
      const refresh = sealed.refreshCiphertext ?? (current[0]?.["refresh_ciphertext"] == null ? null : String(current[0]["refresh_ciphertext"]))
      // Without a refresh token the connection could not synchronize later.
      if (refresh === null) return yield* refuse("NoRefreshToken")
      const expires = new Date(sealed.accessExpiresAt).toISOString()
      yield* sql`INSERT INTO growth_ga4_credentials(connection_id,account_id,refresh_ciphertext,access_ciphertext,access_expires_at)
        VALUES(${connectionId},${session.accountId},${refresh},${sealed.accessCiphertext},${expires}::timestamptz)
        ON CONFLICT (connection_id) DO UPDATE SET refresh_ciphertext=EXCLUDED.refresh_ciphertext, access_ciphertext=EXCLUDED.access_ciphertext, access_expires_at=EXCLUDED.access_expires_at`
      return yield* readConnection(session.accountId, connectionId)
    })),
    credentials: connectionId => Effect.gen(function*() {
      const rows = yield* sql`SELECT c.id, c.account_id, c.google_subject, c.status, k.refresh_ciphertext, k.access_ciphertext, k.access_expires_at
        FROM growth_ga4_connections c LEFT JOIN growth_ga4_credentials k ON k.connection_id=c.id WHERE c.id=${connectionId}`
      const r = rows[0]
      if (!r) return yield* refuse("Ga4ConnectionNotFound")
      return {
        connectionId, accountId: String(r["account_id"]), googleSubject: String(r["google_subject"]), status: Schema.decodeUnknownSync(Ga4ConnectionStatus)(r["status"]),
        refreshCiphertext: r["refresh_ciphertext"] == null ? null : String(r["refresh_ciphertext"]),
        accessCiphertext: r["access_ciphertext"] == null ? null : String(r["access_ciphertext"]),
        accessExpiresAt: r["access_expires_at"] == null ? null : Date.parse(iso(r["access_expires_at"] as Date | string)),
      }
    }),
    storeAccessToken: (connectionId, accessCiphertext, accessExpiresAt) => Effect.gen(function*() {
      yield* sql`UPDATE growth_ga4_credentials SET access_ciphertext=${accessCiphertext}, access_expires_at=${new Date(accessExpiresAt).toISOString()}::timestamptz
        WHERE connection_id=${connectionId} AND EXISTS (SELECT 1 FROM growth_ga4_connections c WHERE c.id=${connectionId} AND c.status='ACTIVE')`
    }),
    suspend: (connectionId, reason) => sql.withTransaction(Effect.gen(function*() {
      const rows = yield* sql`UPDATE growth_ga4_connections SET status='REAUTHORIZATION_REQUIRED', status_reason=${reason} WHERE id=${connectionId} AND status='ACTIVE' RETURNING account_id`
      if (!rows[0]) return
      // The cached access token is useless now; the refresh token is kept only so a disconnect can still try to revoke it.
      yield* sql`UPDATE growth_ga4_credentials SET access_ciphertext=NULL, access_expires_at=NULL WHERE connection_id=${connectionId}`
      yield* event(connectionId, String(rows[0]["account_id"]), "AUTHORIZATION_FAILED", null, { reason })
    })),
    disconnect: (session, connectionId, revocationConfirmed) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session)
      const current = yield* readConnection(session.accountId, connectionId)
      if (current.status !== "DISCONNECTED") {
        // The 0035 trigger erases the stored credentials in the same statement.
        yield* sql`UPDATE growth_ga4_connections SET status='DISCONNECTED', status_reason='DISCONNECTED_BY_OPERATOR', disconnected_at=clock_timestamp(), revocation_confirmed=${revocationConfirmed}
          WHERE id=${connectionId} AND account_id=${session.accountId}`
        yield* event(connectionId, session.accountId, "DISCONNECTED", session.userId, { revocationConfirmed })
        // Nothing queued keeps reading through a connection that no longer exists.
        yield* sql`UPDATE growth_ga4_sync_jobs j SET status='CANCELLED', claimed_by=NULL, lease_expires_at=NULL, last_error='CONNECTION_NOT_ACTIVE'
          FROM growth_ga4_bindings b WHERE b.id=j.binding_id AND b.connection_id=${connectionId} AND j.status='QUEUED'`
      }
      return yield* readConnection(session.accountId, connectionId)
    })),

    bindings: (accountId, businessId) => Effect.gen(function*() {
      yield* business(accountId, businessId)
      const rows = yield* sql`SELECT document, growth_ga4_binding_active(id) AS active FROM growth_ga4_binding_documents WHERE business_id=${businessId} ORDER BY created_at DESC, id DESC LIMIT 50`
      return yield* Effect.forEach(rows, r => Effect.map(decodeRow(BindingDoc, "growth_ga4_bindings", r["document"]), b => ({ ...b, active: r["active"] === true })))
    }),
    bind: (session, businessId, input, verified) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session)
      yield* business(session.accountId, businessId)
      const fingerprint = sha256(JSON.stringify([input.connectionId, input.property, input.metricDefinitionId, input.eventName]))
      const replay = yield* sql`SELECT id, request_fingerprint FROM growth_ga4_bindings WHERE business_id=${businessId} AND request_key=${input.idempotencyKey}`
      if (replay[0]) {
        if (replay[0]["request_fingerprint"] !== fingerprint) return yield* refuse("IdempotencyConflict")
        return { binding: (yield* readBinding(businessId, String(replay[0]["id"]))).binding, replayed: true }
      }
      yield* readConnection(session.accountId, input.connectionId)
      const def = yield* sql`SELECT id FROM growth_metric_definitions WHERE id=${input.metricDefinitionId} AND business_id=${businessId}`
      if (!def[0]) return yield* refuse("MetricDefinitionNotFound")
      const inserted = yield* mapGuard(sql`INSERT INTO growth_ga4_bindings(business_id,connection_id,property,property_display_name,property_account,property_time_zone,metric_definition_id,event_name,provider_metric,key_event_counting_method,created_by_user_id,request_key,request_fingerprint)
        VALUES(${businessId},${input.connectionId},${input.property},${verified.propertyDisplayName.slice(0, 200) || input.property},${verified.propertyAccount},${verified.propertyTimeZone},${input.metricDefinitionId},${input.eventName},'keyEvents',
          ${verified.keyEventCountingMethod},${session.userId},${input.idempotencyKey},${fingerprint}) RETURNING id`)
      return { binding: (yield* readBinding(businessId, String(inserted[0]!["id"]))).binding, replayed: false }
    })),
    checkBindable: (accountId, businessId, input) => Effect.gen(function*() {
      yield* business(accountId, businessId)
      const conn = yield* readConnection(accountId, input.connectionId)
      if (conn.status !== "ACTIVE") return yield* refuse("Ga4ConnectionNotActive")
      const rows = yield* sql`SELECT source_kind, counting_semantics, unit, property_ref, event_name, reporting_time_zone FROM growth_metric_definitions
        WHERE id=${input.metricDefinitionId} AND business_id=${businessId}`
      const d = rows[0]
      if (!d) return yield* refuse("MetricDefinitionNotFound")
      if (d["source_kind"] !== "GA4_AGGREGATE_EXPORT" || d["counting_semantics"] !== "EVENT_COUNT" || d["unit"] !== "COUNT") return yield* refuse("MetricDefinitionNotGa4")
      if (!ga4PropertyMatchesRef(input.property, d["property_ref"] == null ? null : String(d["property_ref"]))) return yield* refuse("PropertyDiffersFromDefinition")
      if (d["event_name"] !== input.eventName) return yield* refuse("KeyEventDiffersFromDefinition")
      return { timeZone: String(d["reporting_time_zone"]) }
    }),
    health: (accountId, businessId, bindingId, nowMs) => Effect.gen(function*() {
      yield* business(accountId, businessId)
      const { binding } = yield* readBinding(businessId, bindingId)
      const conn = yield* sql`SELECT status, google_email FROM growth_ga4_connections WHERE id=${binding.connectionId}`
      const summary = yield* sql`SELECT max(finished_at) FILTER (WHERE outcome IN ('RECORDED','UNCHANGED')) AS last_success, max(finished_at) AS last_attempt
        FROM growth_ga4_sync_runs WHERE binding_id=${bindingId}`
      const latestRun = yield* sql`SELECT outcome, error_code FROM growth_ga4_sync_runs WHERE binding_id=${bindingId} ORDER BY finished_at DESC, id DESC LIMIT 1`
      const jobs = yield* sql`SELECT ${sql.unsafe(JOB_COLUMNS)} FROM growth_ga4_sync_jobs WHERE binding_id=${bindingId} ORDER BY created_at DESC, id DESC LIMIT 10`
      const runs = yield* sql`SELECT id, job_id, attempt, outcome, error_code, import_id, response_digest, days_reported, finished_at FROM growth_ga4_sync_runs WHERE binding_id=${bindingId} ORDER BY finished_at DESC, id DESC LIMIT 10`
      const lastSuccess = summary[0]?.["last_success"] == null ? null : iso(summary[0]["last_success"] as Date | string)
      const lastAttempt = summary[0]?.["last_attempt"] == null ? null : iso(summary[0]["last_attempt"] as Date | string)
      const latestCompleteDay = ga4LatestCompleteDay(nowMs, binding.propertyTimeZone)
      const start = ga4ShiftDay(latestCompleteDay, -27)
      const series = yield* measurement.series(accountId, businessId, binding.metricDefinitionId, start, latestCompleteDay).pipe(
        Effect.catchTag("GrowthMeasurementRefused", e => refuse(e.reason)))
      const count = (status: string) => series.days.filter(d => d.status === status).length
      const allJobs = jobs.map(jobOf)
      return {
        binding, connectionStatus: Schema.decodeUnknownSync(Ga4ConnectionStatus)(conn[0]?.["status"]), connectionEmail: String(conn[0]?.["google_email"] ?? ""),
        freshness: lastSuccess === null ? "NEVER_SYNCED" : nowMs - Date.parse(lastSuccess) > GA4_STALE_AFTER_HOURS * 3_600_000 ? "STALE" : "FRESH",
        lastSuccessfulSyncAt: lastSuccess, lastAttemptAt: lastAttempt,
        lastErrorCode: latestRun[0] && latestRun[0]["error_code"] != null ? String(latestRun[0]["error_code"]) : null,
        openJob: allJobs.find(j => j.status === "QUEUED" || j.status === "CLAIMED") ?? null,
        latestCompleteDay,
        coverage: { start, end: latestCompleteDay, days: series.days.length, reported: count("OK"), missing: count("MISSING"), unavailable: count("UNAVAILABLE"), conflicting: count("CONFLICT"), revised: series.revisions?.length ?? 0 },
        recentJobs: allJobs, recentRuns: runs.map(runOf),
      } satisfies Ga4BindingHealth
    }),

    requestSync: (session, businessId, bindingId, input) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session)
      yield* business(session.accountId, businessId)
      const { binding, active } = yield* readBinding(businessId, bindingId)
      const fingerprint = sha256(JSON.stringify([input.kind, input.dateStart, input.dateEnd]))
      const replay = yield* sql`SELECT ${sql.unsafe(JOB_COLUMNS)}, request_fingerprint FROM growth_ga4_sync_jobs WHERE binding_id=${bindingId} AND request_key=${input.idempotencyKey}`
      if (replay[0]) {
        if (replay[0]["request_fingerprint"] !== fingerprint) return yield* refuse("IdempotencyConflict")
        return { job: jobOf(replay[0]), replayed: true }
      }
      if (!active) return yield* refuse("BindingInactive")
      const conn = yield* sql`SELECT status FROM growth_ga4_connections WHERE id=${binding.connectionId}`
      if (conn[0]?.["status"] !== "ACTIVE") return yield* refuse("Ga4ConnectionNotActive")
      // Serializes concurrent requests for one binding before the one-open-job check.
      yield* sql`SELECT id FROM growth_ga4_bindings WHERE id=${bindingId} FOR UPDATE`
      const open = yield* sql`SELECT id FROM growth_ga4_sync_jobs WHERE binding_id=${bindingId} AND status IN ('QUEUED','CLAIMED')`
      if (open[0]) return yield* refuse("SyncAlreadyOpen")
      const inserted = yield* mapGuard(sql`INSERT INTO growth_ga4_sync_jobs(binding_id,business_id,kind,date_start,date_end,request_key,request_fingerprint,requested_by_user_id)
        VALUES(${bindingId},${businessId},${input.kind},${input.dateStart}::date,${input.dateEnd}::date,${input.idempotencyKey},${fingerprint},${session.userId}) RETURNING ${sql.unsafe(JOB_COLUMNS)}`)
      return { job: jobOf(inserted[0]!), replayed: false }
    })),
    scheduleDue: opts => Effect.gen(function*() {
      const only = opts.onlyBindings
      const rows = yield* sql`INSERT INTO growth_ga4_sync_jobs(binding_id,business_id,kind,date_start,date_end)
        SELECT b.id, b.business_id, 'SCHEDULED',
          ((now() AT TIME ZONE b.property_time_zone)::date - 1) - ${opts.refreshDays - 1}::int,
          ((now() AT TIME ZONE b.property_time_zone)::date - 1)
        FROM growth_ga4_bindings b JOIN growth_ga4_connections c ON c.id=b.connection_id
        WHERE c.status='ACTIVE' AND growth_ga4_binding_active(b.id)
          AND (${only ?? null}::uuid[] IS NULL OR b.id = ANY(${only ?? null}::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM growth_ga4_sync_jobs j WHERE j.binding_id=b.id AND j.status IN ('QUEUED','CLAIMED'))
          AND NOT EXISTS (SELECT 1 FROM growth_ga4_sync_jobs j WHERE j.binding_id=b.id AND j.kind='SCHEDULED' AND j.created_at > now() - ${opts.intervalHours}*interval '1 hour')
        ORDER BY b.created_at LIMIT ${opts.limit}
        ON CONFLICT DO NOTHING RETURNING id`
      return rows.length
    }),
    claimJob: (workerId, leaseSeconds, only) => sql.withTransaction(Effect.gen(function*() {
      // SKIP LOCKED: one claim per job; an expired lease (crashed worker) is reclaimed.
      const rows = yield* sql`SELECT id FROM growth_ga4_sync_jobs
        WHERE ((status='QUEUED' AND not_before<=now()) OR (status='CLAIMED' AND lease_expires_at<now()))
          AND (${only ?? null}::uuid[] IS NULL OR binding_id = ANY(${only ?? null}::uuid[]))
        ORDER BY not_before, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
      if (!rows[0]) return null
      const claimed = yield* sql`UPDATE growth_ga4_sync_jobs SET status='CLAIMED', claimed_by=${workerId}, lease_expires_at=now()+${leaseSeconds}*interval '1 second', attempt_count=attempt_count+1
        WHERE id=${String(rows[0]["id"])} RETURNING id, binding_id, business_id, kind, date_start::text AS date_start, date_end::text AS date_end, attempt_count`
      const r = claimed[0]!
      return { id: String(r["id"]), bindingId: String(r["binding_id"]), businessId: String(r["business_id"]), kind: Schema.decodeUnknownSync(Ga4SyncKind)(r["kind"]),
        dateStart: String(r["date_start"]), dateEnd: String(r["date_end"]), attemptCount: Number(r["attempt_count"]) }
    })),
    work: job => Effect.gen(function*() {
      const { binding, active } = yield* readBinding(job.businessId, job.bindingId)
      const rows = yield* sql`SELECT b.account_id, j.requested_by_user_id, record_member(j.business_id, COALESCE(j.requested_by_user_id, g.created_by_user_id)) AS importer_member
        FROM growth_ga4_sync_jobs j JOIN businesses b ON b.id=j.business_id JOIN growth_ga4_bindings g ON g.id=j.binding_id WHERE j.id=${job.id}`
      const c = yield* sql`SELECT c.id, c.account_id, c.google_subject, c.status, k.refresh_ciphertext, k.access_ciphertext, k.access_expires_at
        FROM growth_ga4_connections c LEFT JOIN growth_ga4_credentials k ON k.connection_id=c.id WHERE c.id=${binding.connectionId}`
      const r = c[0]!
      return {
        job, binding, bindingActive: active, accountId: String(rows[0]!["account_id"]),
        importedByUserId: rows[0]!["requested_by_user_id"] == null ? binding.createdByUserId : String(rows[0]!["requested_by_user_id"]),
        importerIsMember: rows[0]!["importer_member"] === true,
        credentials: {
          connectionId: binding.connectionId, accountId: String(r["account_id"]), googleSubject: String(r["google_subject"]), status: Schema.decodeUnknownSync(Ga4ConnectionStatus)(r["status"]),
          refreshCiphertext: r["refresh_ciphertext"] == null ? null : String(r["refresh_ciphertext"]),
          accessCiphertext: r["access_ciphertext"] == null ? null : String(r["access_ciphertext"]),
          accessExpiresAt: r["access_expires_at"] == null ? null : Date.parse(iso(r["access_expires_at"] as Date | string)),
        },
      }
    }),
    retryJob: (job, workerId, delaySeconds, code, quota) => sql.withTransaction(Effect.gen(function*() {
      yield* lockOwnJob(job, workerId)
      yield* runRow(job, "RETRYING", { errorCode: code, quota: quota ?? null })
      yield* sql`UPDATE growth_ga4_sync_jobs SET status='QUEUED', claimed_by=NULL, lease_expires_at=NULL, not_before=now()+${delaySeconds}*interval '1 second', last_error=${code}
        WHERE id=${job.id}`
    })),
    failJob: (job, workerId, code) => sql.withTransaction(Effect.gen(function*() {
      yield* lockOwnJob(job, workerId)
      yield* runRow(job, "FAILED", { errorCode: code })
      yield* sql`UPDATE growth_ga4_sync_jobs SET status='FAILED', claimed_by=NULL, lease_expires_at=NULL, last_error=${code} WHERE id=${job.id}`
    })),
    recordObservation: (job, workerId, input) => sql.withTransaction(Effect.gen(function*() {
      yield* lockOwnJob(job, workerId)
      // One binding is recorded by one transaction at a time.
      yield* sql`SELECT id FROM growth_ga4_bindings WHERE id=${job.bindingId} FOR UPDATE`
      const { binding } = yield* readBinding(job.businessId, job.bindingId)
      const days = new Map<string, number>()
      for (const row of input.rows) {
        if (row.day < job.dateStart || row.day > job.dateEnd || days.has(row.day) || !Number.isInteger(row.value) || row.value < 0) return yield* refuse("ResponseUnexpected")
        days.set(row.day, row.value)
      }
      // The latest authenticated state of every requested day: the newest
      // authenticated import covering the day, with its value or its absence.
      const state = yield* sql`WITH period AS (SELECT generate_series(${job.dateStart}::date, ${job.dateEnd}::date, interval '1 day')::date AS day)
        SELECT p.day::text AS day, latest.import_id, latest.value, latest.covered
        FROM period p LEFT JOIN LATERAL (
          SELECT i.id AS import_id, r.value, true AS covered FROM growth_metric_imports i
          LEFT JOIN growth_metric_rows r ON r.import_id=i.id AND r.business_id=i.business_id AND r.day=p.day
          WHERE i.business_id=${job.businessId} AND i.metric_definition_id=${binding.metricDefinitionId} AND i.provenance='AUTHENTICATED_PROVIDER_API'
            AND i.date_start <= p.day AND i.date_end >= p.day
          ORDER BY i.imported_at DESC, i.id DESC LIMIT 1) latest ON true ORDER BY p.day`
      const unchanged = state.every(s => s["covered"] === true
        && (s["value"] == null ? !days.has(String(s["day"])) : days.get(String(s["day"])) === Number(s["value"])))
      const newest = yield* sql`SELECT o.import_id FROM growth_ga4_observations o JOIN growth_metric_imports i ON i.id=o.import_id
        WHERE o.binding_id=${job.bindingId} AND o.requested_start <= ${job.dateEnd}::date AND o.requested_end >= ${job.dateStart}::date
        ORDER BY i.imported_at DESC, i.id DESC LIMIT 1`
      const newestImport = newest[0] ? String(newest[0]["import_id"]) : null
      if (unchanged && newestImport !== null) {
        // The same answer again: no new evidence is written, the confirmation is.
        yield* runRow(job, "UNCHANGED", { importId: newestImport, responseDigest: input.responseDigest, daysReported: days.size, quota: input.quota })
        yield* sql`UPDATE growth_ga4_sync_jobs SET status='SUCCEEDED', claimed_by=NULL, lease_expires_at=NULL, last_error=NULL WHERE id=${job.id}`
        return { outcome: "UNCHANGED" as const, importId: newestImport }
      }
      const meta = yield* sql`SELECT d.source_kind, d.property_ref, d.reporting_time_zone, d.version, c.google_subject,
          COALESCE(j.requested_by_user_id, b.created_by_user_id) AS importer
        FROM growth_ga4_bindings b JOIN growth_metric_definitions d ON d.id=b.metric_definition_id AND d.business_id=b.business_id
        JOIN growth_ga4_connections c ON c.id=b.connection_id JOIN growth_ga4_sync_jobs j ON j.id=${job.id}
        WHERE b.id=${job.bindingId}`
      const m = meta[0]!
      const sorted = [...days.keys()].sort()
      const imported = yield* mapGuard(sql`INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id)
        VALUES(${job.businessId},${binding.metricDefinitionId},${String(m["source_kind"])},'AUTHENTICATED_PROVIDER_API',${String(m["property_ref"])},${job.dateStart}::date,${job.dateEnd}::date,
          ${String(m["reporting_time_zone"])},${input.rawText},${sha256(input.rawText)},${days.size},${String(m["importer"])}) RETURNING id`)
      const importId = String(imported[0]!["id"])
      yield* mapGuard(sql`INSERT INTO growth_ga4_observations(import_id,business_id,binding_id,connection_id,google_subject,job_id,property,event_name,provider_metric,metric_definition_id,metric_definition_version,
          time_zone,requested_start,requested_end,observed_start,observed_end,response_digest,subject_to_thresholding,supersedes_import_id)
        VALUES(${importId},${job.businessId},${job.bindingId},${binding.connectionId},${String(m["google_subject"])},${job.id},${binding.property},${binding.eventName},'keyEvents',
          ${binding.metricDefinitionId},${Number(m["version"])},${binding.propertyTimeZone},${job.dateStart}::date,${job.dateEnd}::date,
          ${sorted[0] ?? null}::date,${sorted[sorted.length - 1] ?? null}::date,${input.responseDigest},${input.subjectToThresholding},${newestImport})`)
      for (const [day, value] of days) yield* mapGuard(sql`INSERT INTO growth_metric_rows(import_id,business_id,day,value) VALUES(${importId},${job.businessId},${day}::date,${value})`)
      yield* runRow(job, "RECORDED", { importId, responseDigest: input.responseDigest, daysReported: days.size, quota: input.quota })
      yield* sql`UPDATE growth_ga4_sync_jobs SET status='SUCCEEDED', claimed_by=NULL, lease_expires_at=NULL, last_error=NULL WHERE id=${job.id}`
      return { outcome: "RECORDED" as const, importId }
    })),
  } satisfies Context.Tag.Service<GrowthGa4Repository>
}))
