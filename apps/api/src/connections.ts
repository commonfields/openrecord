// Connections, in one shape. Each provider keeps its own storage (Google
// sign-ins, ad sign-ins, Stripe keys, WordPress and Webflow credentials,
// repositories); this module describes all of them the same way:
//
//   how a person connects it        (sign in, paste a key, or the team sets it up)
//   what it lets the agent do       (and which tools it gates)
//   whether it is ready for one business, and if not, what is missing
//   when it was last checked, and what the check found.
//
// A check is one cheap authenticated read per connection, run in the
// background. A credential the provider refuses is marked on its own
// connection by the check (as a failed read would), so the connection table
// stays the source of truth; connection_checks records when that was last
// confirmed and keeps an unexplained failure (a timeout, an outage) visible
// without treating it as a revoked credential.
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Cause, Data, Effect, Option, Schedule } from "effect"
import { BusinessRepository, GrowthGa4Repository, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { Ga4Provider } from "@openrecord/ga4"
import { GitHubExecution } from "@openrecord/site-operator"
import { adsConfig, checkAdConnection } from "./ads.js"
import { checkGoogleConnection } from "./growth-ga4-routes.js"
import { checkStripe } from "./revenue.js"
import { checkWordPress } from "./wordpress.js"
import { checkWebflow } from "./webflow.js"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

export type ConnectorId = "google" | "google_ads" | "google_business" | "meta" | "linkedin" | "stripe" | "wordpress" | "webflow" | "github"
/** How a person connects it: sign in with the provider, paste a key from it, or the OpenRecord team sets it up. */
export type ConnectMethod = "SIGN_IN" | "PASTE_KEY" | "TEAM"
export type ConnectorState =
  /** Connected, working, and chosen for this business. */
  | "READY"
  /** Signed in, but no account, site or property is chosen for this business yet. */
  | "NEEDS_SETUP"
  /** The provider refused the stored credential: the person signs in or pastes a key again. */
  | "NEEDS_RECONNECT"
  | "NOT_CONNECTED"
  /** OpenRecord is not set up with this provider on this server, so nobody can connect it yet. */
  | "UNAVAILABLE"
export type CheckResult = "OK" | "NEEDS_RECONNECT" | "FAILING"

export interface ConnectorSpec {
  readonly id: ConnectorId
  readonly label: string
  readonly method: ConnectMethod
  /** What it lets the agent do, in one sentence for the person. */
  readonly enables: string
  /** Tools that can only refuse until this is ready. A tool gated by several connectors needs any one of them. */
  readonly gates: ReadonlyArray<string>
}

/** Every connection OpenRecord offers, in the order a person sees them. */
export const CONNECTORS: ReadonlyArray<ConnectorSpec> = [
  { id: "google", label: "Google Search Console and Analytics", method: "SIGN_IN", enables: "Search clicks, queries and signups, to measure what a change did.", gates: [] },
  { id: "github", label: "Website repository", method: "TEAM", enables: "Opens pull requests with approved page changes on a site built from code.", gates: ["prepare_page_change"] },
  { id: "wordpress", label: "WordPress", method: "PASTE_KEY", enables: "Reads posts and pages, and publishes approved changes with an undo.", gates: ["read_wordpress_content", "prepare_wordpress_change"] },
  { id: "webflow", label: "Webflow", method: "PASTE_KEY", enables: "Reads pages and CMS items, and publishes approved changes with an undo.", gates: ["read_webflow_content", "prepare_webflow_change"] },
  { id: "google_ads", label: "Google Ads", method: "SIGN_IN", enables: "Reads campaigns and spend, and prepares changes for approval.", gates: ["read_ad_campaigns", "prepare_account_action"] },
  { id: "google_business", label: "Google Business Profile", method: "SIGN_IN", enables: "Reads profile views, search terms and reviews, and drafts review replies.", gates: ["read_reviews", "prepare_account_action"] },
  { id: "meta", label: "Meta ads", method: "SIGN_IN", enables: "Reads Facebook and Instagram ad performance and spend.", gates: [] },
  { id: "linkedin", label: "LinkedIn", method: "SIGN_IN", enables: "Publishes approved posts to a company page or profile, and reads how page posts did.", gates: ["read_linkedin_posts", "prepare_account_action"] },
  { id: "stripe", label: "Stripe", method: "PASTE_KEY", enables: "Reads revenue, to tie marketing to money.", gates: [] },
]

export interface ConnectionCheck {
  readonly result: CheckResult
  readonly reason: string | null
  readonly checkedAt: string
  readonly lastOkAt: string | null
}
export interface ConnectedAccount {
  /** The connection's own id (for a per-business credential, the business). */
  readonly id: string
  /** Who or what it is connected as: an email, a site, an account name. Never a secret. */
  readonly name: string
  readonly status: "ACTIVE" | "NEEDS_RECONNECT"
  readonly connectedAt: string | null
  /** Whether this connection serves this business (a sign-in can serve several, once a site or account is chosen). */
  readonly forBusiness: boolean
  readonly check: ConnectionCheck | null
}
export interface ConnectorStatus extends ConnectorSpec {
  readonly state: ConnectorState
  /** What is true and what to do next, in a sentence for the person. */
  readonly detail: string
  readonly accounts: ReadonlyArray<ConnectedAccount>
}

const iso = (v: unknown) => v ? new Date(v as string).toISOString() : null
const statusOf = (s: unknown): "ACTIVE" | "NEEDS_RECONNECT" => s === "ACTIVE" ? "ACTIVE" : "NEEDS_RECONNECT"

/** The state for a business from its connections. Shared by every connector so the rules cannot drift. */
export const stateOf = (configured: boolean, accounts: ReadonlyArray<Pick<ConnectedAccount, "status" | "forBusiness">>): ConnectorState => {
  if (!configured) return "UNAVAILABLE"
  const serving = accounts.filter(a => a.forBusiness)
  if (serving.some(a => a.status === "ACTIVE")) return "READY"
  if (serving.length) return "NEEDS_RECONNECT"
  if (accounts.some(a => a.status === "ACTIVE")) return "NEEDS_SETUP"
  return accounts.length ? "NEEDS_RECONNECT" : "NOT_CONNECTED"
}

const detailOf = (spec: ConnectorSpec, state: ConnectorState, accounts: ReadonlyArray<ConnectedAccount>): string => {
  const serving = accounts.find(a => a.forBusiness && a.status === "ACTIVE") ?? accounts.find(a => a.forBusiness) ?? accounts[0]
  switch (state) {
    case "UNAVAILABLE": return `${spec.label} is not set up on this OpenRecord server yet, so it cannot be connected.`
    case "NOT_CONNECTED": return spec.method === "TEAM" ? `No ${spec.label.toLowerCase()} is connected. The OpenRecord team connects it.` : `${spec.label} is not connected.`
    case "NEEDS_SETUP": return `Signed in as ${serving?.name ?? "an account"}. Choose which ${spec.id === "google" ? "site or property" : "account"} belongs to this business.`
    case "NEEDS_RECONNECT": return `${spec.label} stopped accepting the saved ${spec.method === "PASTE_KEY" ? "key" : "sign-in"} for ${serving?.name ?? "this business"}. Connect it again.`
    case "READY": {
      const check = serving?.check
      return check?.result === "FAILING"
        ? `Connected as ${serving!.name}. The last check could not reach ${spec.label}${check.lastOkAt ? `; it last worked ${check.lastOkAt.slice(0, 10)}` : ""}.`
        : `Connected as ${serving?.name ?? spec.label}.`
    }
  }
}

const checksFor = (accountId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT connector, connection_id, result, reason, checked_at, last_ok_at FROM connection_checks WHERE account_id = ${accountId} AND result IS NOT NULL`
  return new Map(rows.map(r => [`${r["connector"]}:${r["connection_id"]}`, {
    result: r["result"] as CheckResult, reason: (r["reason"] as string | null) ?? null, checkedAt: iso(r["checked_at"])!, lastOkAt: iso(r["last_ok_at"]),
  } satisfies ConnectionCheck]))
})

/** Every connector's state for one business, with the accounts behind it. */
export const connectorStatuses = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const ads = yield* adsConfig
  const ga4 = yield* Effect.serviceOption(Ga4Provider)
  const github = yield* Effect.serviceOption(GitHubExecution)
  const checks = yield* checksFor(accountId)
  const withCheck = (connector: ConnectorId, a: Omit<ConnectedAccount, "check">): ConnectedAccount => {
    const check = checks.get(`${connector}:${a.id}`) ?? null
    // A refused credential that is active again was reconnected after the check: that check no longer describes it.
    return { ...a, check: check && !(check.result === "NEEDS_RECONNECT" && a.status === "ACTIVE") ? check : null }
  }

  const googleConfigured = Option.isSome(ga4) && ga4.value.configured
  const googleRows = yield* sql`SELECT id, google_email, status, last_authorized_at FROM growth_ga4_connections WHERE account_id = ${accountId} AND status <> 'DISCONNECTED' ORDER BY created_at`
  const searchSites = yield* sql`SELECT connection_id FROM search_console_bindings WHERE account_id = ${accountId} AND business_id = ${businessId} AND ended_at IS NULL`
  const ga4Repo = yield* Effect.serviceOption(GrowthGa4Repository)
  const properties = googleConfigured && Option.isSome(ga4Repo) ? (yield* ga4Repo.value.bindings(accountId, businessId)).filter(b => b.active) : []
  const serving = new Set([...searchSites.map(r => String(r["connection_id"])), ...properties.map(b => b.connectionId)])
  const google = googleRows.map(r => withCheck("google", {
    id: String(r["id"]), name: String(r["google_email"]), status: statusOf(r["status"]), connectedAt: iso(r["last_authorized_at"]), forBusiness: serving.has(String(r["id"])),
  }))

  const adRows = yield* sql`SELECT c.id, c.provider, c.display_name, c.status, c.connected_at,
      EXISTS(SELECT 1 FROM ad_account_bindings b WHERE b.connection_id = c.id AND b.business_id = ${businessId} AND b.ended_at IS NULL) AS bound
    FROM ad_connections c WHERE c.account_id = ${accountId} AND c.status <> 'DISCONNECTED' ORDER BY c.connected_at`
  const adAccounts = (provider: ConnectorId) => adRows.filter(r => r["provider"] === provider).map(r => withCheck(provider, {
    id: String(r["id"]), name: String(r["display_name"]), status: statusOf(r["status"]), connectedAt: iso(r["connected_at"]), forBusiness: r["bound"] === true,
  }))

  const one = (connector: ConnectorId, rows: ReadonlyArray<Record<string, unknown>>, name: (r: Record<string, unknown>) => string, id: (r: Record<string, unknown>) => string) =>
    rows.map(r => withCheck(connector, { id: id(r), name: name(r), status: statusOf(r["status"]), connectedAt: iso(r["connected_at"]), forBusiness: true }))
  const stripe = one("stripe", yield* sql`SELECT id, display_name, status, connected_at FROM revenue_connections
    WHERE account_id = ${accountId} AND business_id = ${businessId} AND provider = 'stripe' AND status <> 'DISCONNECTED'`, r => String(r["display_name"]), r => String(r["id"]))
  const wordpress = one("wordpress", yield* sql`SELECT business_id, site_name, site_url, status, connected_at FROM wordpress_connections
    WHERE account_id = ${accountId} AND business_id = ${businessId} AND status <> 'DISCONNECTED'`, r => String(r["site_name"] || r["site_url"]), r => String(r["business_id"]))
  const webflow = one("webflow", yield* sql`SELECT business_id, site_name, site_url, status, connected_at FROM webflow_connections
    WHERE account_id = ${accountId} AND business_id = ${businessId} AND status <> 'DISCONNECTED'`, r => String(r["site_name"] || r["site_url"]), r => String(r["business_id"]))
  const repositories = (yield* sql`SELECT t.id, t.owner, t.repository, t.created_at FROM growth_execution_targets t JOIN businesses b ON b.id = t.business_id
    WHERE t.business_id = ${businessId} AND b.account_id = ${accountId} ORDER BY t.created_at`).map((r): ConnectedAccount => ({
      id: String(r["id"]), name: `${r["owner"]}/${r["repository"]}`, status: "ACTIVE", connectedAt: iso(r["created_at"]), forBusiness: true, check: null }))

  const of: Record<ConnectorId, { readonly configured: boolean; readonly accounts: ReadonlyArray<ConnectedAccount> }> = {
    google: { configured: googleConfigured, accounts: google },
    github: { configured: Option.isSome(github) && github.value.transport !== null, accounts: repositories },
    wordpress: { configured: ads.cipher !== null, accounts: wordpress },
    webflow: { configured: ads.cipher !== null, accounts: webflow },
    google_ads: { configured: ads.googleAds.configured, accounts: adAccounts("google_ads") },
    google_business: { configured: ads.googleBusiness.configured, accounts: adAccounts("google_business") },
    meta: { configured: ads.meta.configured, accounts: adAccounts("meta") },
    linkedin: { configured: ads.linkedin.configured, accounts: adAccounts("linkedin") },
    stripe: { configured: ads.stripe.configured && ads.cipher !== null, accounts: stripe },
  }
  return CONNECTORS.map((spec): ConnectorStatus => {
    const { configured, accounts } = of[spec.id]
    const state = stateOf(configured, accounts)
    return { ...spec, state, detail: detailOf(spec, state, accounts), accounts }
  })
})

/**
 * The tools a business cannot use this turn because what they work on is not
 * ready, and a sentence for the instructions saying so. A tool gated by
 * several connectors (an ad or profile action) is offered when any is ready.
 */
export const gapsOf = (statuses: ReadonlyArray<ConnectorStatus>) => {
  const ready = new Set(statuses.filter(s => s.state === "READY").map(s => s.id))
  const gating = statuses.filter(s => s.gates.length)
  const withheld = new Set(gating.flatMap(s => s.gates).filter(tool => !gating.some(s => s.gates.includes(tool) && ready.has(s.id))))
  const missing = gating.filter(s => !ready.has(s.id))
  const group = (states: ReadonlyArray<ConnectorState>) => missing.filter(s => states.includes(s.state)).map(s => s.label)
  const parts = [
    group(["NOT_CONNECTED", "UNAVAILABLE"]).length ? `not connected: ${group(["NOT_CONNECTED", "UNAVAILABLE"]).join(", ")}` : "",
    group(["NEEDS_SETUP"]).length ? `connected but not yet chosen for this business: ${group(["NEEDS_SETUP"]).join(", ")}` : "",
    group(["NEEDS_RECONNECT"]).length ? `must be connected again: ${group(["NEEDS_RECONNECT"]).join(", ")}` : "",
  ].filter(Boolean)
  return {
    withheld,
    note: parts.length ? `\n\nFor this business, ${parts.join("; ")}. Tools that need them are not offered this turn; if the request needs one, say so and that the person can connect it on the Channels page.` : "",
  }
}

// ---------------------------------------------------------------- checks

/** Reasons that mean the provider refused the credential itself. */
const RECONNECT = new Set([
  "Ga4ReauthorizationRequired", "AdsReauthorizationRequired", "RevenueKeyRefused", "WordPressCredentialRefused", "SiteAUTH", "WebflowCredentialRefused", "WebflowAUTH",
])
export class ConnectionsRefused extends Data.TaggedError("ConnectionsRefused")<{ readonly reason: string }> {}

/** What one check found. A provider's refusal reason is kept; anything else is a failure to check, not a revoked credential. */
export const classify = (e: unknown): { readonly result: Exclude<CheckResult, "OK">; readonly reason: string } => {
  const reason = typeof e === "object" && e !== null && "reason" in e && typeof e.reason === "string" && /^[A-Za-z0-9_]{1,80}$/.test(e.reason) ? e.reason : "CheckFailed"
  return { result: RECONNECT.has(reason) ? "NEEDS_RECONNECT" : "FAILING", reason }
}

interface Due { readonly connector: Exclude<ConnectorId, "github">; readonly connectionId: string; readonly accountId: string; readonly businessId: string | null }
const run = (d: Due) => Effect.gen(function*() {
  if (d.connector === "google") return yield* checkGoogleConnection(d.accountId, d.connectionId)
  if (d.connector === "stripe") return yield* checkStripe(d.accountId, d.businessId!)
  if (d.connector === "wordpress") return yield* checkWordPress(d.accountId, d.businessId!)
  if (d.connector === "webflow") return yield* checkWebflow(d.accountId, d.businessId!)
  return yield* checkAdConnection(d.accountId, d.connectionId)
})
/** How long until the next check: twelve hours when it works, sooner after an unexplained failure, a day once the credential is refused. */
export const nextCheckMinutes = (result: CheckResult, failures: number) =>
  result === "OK" ? 12 * 60 : result === "NEEDS_RECONNECT" ? 24 * 60 : Math.min(12 * 60, 30 * 2 ** Math.min(failures, 5))

/** Checks one connection and records the result. Never fails: a check that cannot run is itself recorded. */
const checkOne = (d: Due) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const outcome = yield* run(d).pipe(
    Effect.timeout("30 seconds"),
    Effect.as({ result: "OK" as CheckResult, reason: null as string | null }),
    Effect.catchAllCause(cause => Effect.succeed(Cause.failureOption(cause).pipe(Option.match({ onNone: () => ({ result: "FAILING" as const, reason: "CheckFailed" }), onSome: classify })))),
  )
  const row = (yield* sql`SELECT failures FROM connection_checks WHERE connector = ${d.connector} AND connection_id = ${d.connectionId}`)[0]
  const failures = outcome.result === "OK" ? 0 : Number(row?.["failures"] ?? 0) + 1
  yield* sql`UPDATE connection_checks SET result = ${outcome.result}, reason = ${outcome.reason}, checked_at = now(),
      last_ok_at = CASE WHEN ${outcome.result} = 'OK' THEN now() ELSE last_ok_at END, failures = ${failures},
      next_check_at = now() + make_interval(mins => ${nextCheckMinutes(outcome.result, failures)}), lease_until = NULL
    WHERE connector = ${d.connector} AND connection_id = ${d.connectionId}`
  return outcome
})

/**
 * Active connections whose check is due, claimed with a short lease so two
 * servers never check the same one. A connection the person reconnected after
 * a refused check is due at once.
 */
const claimDue = (limit: number, scope?: { readonly accountId: string; readonly businessId: string; readonly freshSeconds: number }) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const account = scope?.accountId ?? null, business = scope?.businessId ?? null
  const rows = yield* sql`WITH conns AS (
      SELECT 'google' AS connector, id::text AS connection_id, account_id, NULL::uuid AS business_id FROM growth_ga4_connections WHERE status = 'ACTIVE'
        AND (${business}::uuid IS NULL OR id IN (SELECT connection_id FROM search_console_bindings WHERE business_id = ${business}::uuid AND ended_at IS NULL)
          OR id IN (SELECT connection_id FROM growth_ga4_bindings WHERE business_id = ${business}::uuid))
      UNION ALL SELECT provider, id::text, account_id, NULL::uuid FROM ad_connections WHERE status = 'ACTIVE'
        AND (${business}::uuid IS NULL OR id IN (SELECT connection_id FROM ad_account_bindings WHERE business_id = ${business}::uuid AND ended_at IS NULL))
      UNION ALL SELECT 'stripe', id::text, account_id, business_id FROM revenue_connections WHERE status = 'ACTIVE' AND provider = 'stripe'
      UNION ALL SELECT 'wordpress', business_id::text, account_id, business_id FROM wordpress_connections WHERE status = 'ACTIVE'
      UNION ALL SELECT 'webflow', business_id::text, account_id, business_id FROM webflow_connections WHERE status = 'ACTIVE'
    )
    SELECT c.connector, c.connection_id, c.account_id, c.business_id FROM conns c
    LEFT JOIN connection_checks k ON k.connector = c.connector AND k.connection_id = c.connection_id
    WHERE (${account}::uuid IS NULL OR c.account_id = ${account}::uuid)
      AND (${business}::uuid IS NULL OR c.business_id IS NULL OR c.business_id = ${business}::uuid)
      AND (k.lease_until IS NULL OR k.lease_until < now())
      AND (${scope ? 1 : 0} = 1 AND (k.checked_at IS NULL OR k.checked_at < now() - make_interval(secs => ${scope?.freshSeconds ?? 0}))
        OR k.connector IS NULL OR k.next_check_at <= now() OR k.result = 'NEEDS_RECONNECT')
    ORDER BY k.next_check_at NULLS FIRST LIMIT ${limit}`
  const claimed: Due[] = []
  for (const r of rows) {
    const got = yield* sql`INSERT INTO connection_checks(connector, connection_id, account_id, next_check_at, lease_until)
        VALUES (${r["connector"] as string}, ${r["connection_id"] as string}, ${r["account_id"] as string}, now(), now() + interval '2 minutes')
      ON CONFLICT (connector, connection_id) DO UPDATE SET lease_until = EXCLUDED.lease_until
        WHERE connection_checks.lease_until IS NULL OR connection_checks.lease_until < now()
      RETURNING connector`
    if (got.length) claimed.push({ connector: r["connector"] as Due["connector"], connectionId: String(r["connection_id"]), accountId: String(r["account_id"]), businessId: r["business_id"] ? String(r["business_id"]) : null })
  }
  return claimed
})

/** Checks the connections that are due, a few at a time. Returns how many were checked. */
export const runDueChecks = (limit = 20) => Effect.gen(function*() {
  const due = yield* claimDue(limit)
  yield* Effect.forEach(due, checkOne, { concurrency: 4, discard: true })
  return due.length
})

/** Every ten minutes, after the server has started. */
export const connectionCheckScheduler = runDueChecks().pipe(
  Effect.catchAllCause(cause => Effect.logWarning("connection checks").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause).slice(0, 300) }))),
  Effect.repeat(Schedule.spaced("10 minutes")),
)

/** Checks one business's connections now (those not checked in the last minute). */
export const checkBusinessConnections = (accountId: string, businessId: string) => Effect.gen(function*() {
  const due = yield* claimDue(20, { accountId, businessId, freshSeconds: 60 })
  yield* Effect.forEach(due, checkOne, { concurrency: 4, discard: true })
  return due.length
})

// ---------------------------------------------------------------- routes

const PRIVATE = { "cache-control": "no-store" }
const failure = (e: unknown) => {
  if (e instanceof ConnectionsRefused) return json(e.reason === "InvalidRequest" ? 422 : 404, { _tag: "ConnectionsRefused", reason: e.reason }, PRIVATE)
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  return json(500, { _tag: "ConnectionsRequestFailed" }, PRIVATE)
}

export const connectionsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const business = <E, R>(run: (session: Session, businessId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* Effect.fail(new ConnectionsRefused({ reason: "InvalidRequest" }))
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* Effect.fail(new ConnectionsRefused({ reason: "BusinessNotFound" }))
      return yield* run(session, businessId)
    })).pipe(Effect.catchAll(failure))
  const base = "/api/businesses/:id/connections"
  return HttpRouter.empty.pipe(
    // Every connection for the business in one list: what it is, how to connect it, whether it is ready, and when it was last checked.
    HttpRouter.get(base, business((session, businessId) => Effect.gen(function*() {
      return yield* json(200, { connectors: yield* connectorStatuses(session.accountId, businessId) }, PRIVATE)
    }))),
    // Checks this business's connections now, then returns the list.
    HttpRouter.post(`${base}/check`, business((session, businessId) => Effect.gen(function*() {
      const checked = yield* checkBusinessConnections(session.accountId, businessId)
      return yield* json(200, { checked, connectors: yield* connectorStatuses(session.accountId, businessId) }, PRIVATE)
    }))),
  )
}
