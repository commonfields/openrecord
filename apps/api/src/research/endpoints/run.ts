// Runs catalog endpoints as research capabilities, and manages each
// business's provider connections. A credential is decrypted only here, for
// one call, and is scrubbed from anything that comes back. Endpoints whose
// provider needs an account are not available until the business connects
// one; optional credentials only raise rate limits.
import { SqlClient } from "@effect/sql"
import { HttpRouter, type HttpServerResponse } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { adsConfig } from "../../ads.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "../../record-routes.js"
import { ResearchHttp } from "../net.js"
import { refuse, type AnyCapability, type Observed, type Refused, type RunContext, type TimelineEvent } from "../types.js"
import { ACCOUNT_ENDPOINTS } from "./defs-accounts.js"
import { PUBLIC_ENDPOINTS } from "./defs-public.js"
import { SEO_ENDPOINTS } from "./defs-seo.js"
import { clientToken, prepare, scrub, send, type CallFailure } from "./http.js"
import { CONNECTABLE, provider as providerOf } from "./providers.js"
import type { AnyEndpoint, Provider } from "./types.js"

export const ENDPOINTS: ReadonlyArray<AnyEndpoint> = [...PUBLIC_ENDPOINTS, ...ACCOUNT_ENDPOINTS, ...SEO_ENDPOINTS]
const context = (businessId: string, providerId: string) => `research:${businessId}:${providerId}`
const transport = Effect.map(Effect.serviceOption(ResearchHttp), Option.getOrUndefined)

/** The business's decrypted credential for a provider, or null. */
const credentialFor = (businessId: string, providerId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const r = (yield* sql`SELECT credential_ciphertext FROM research_connections WHERE business_id = ${businessId} AND provider = ${providerId} AND status = 'ACTIVE'`)[0]
  const cipher = (yield* adsConfig).cipher
  const c = r?.["credential_ciphertext"]
  return typeof c === "string" && cipher ? cipher.decrypt(c, context(businessId, providerId)) : null
})
const needsCredential = (p: Provider) => p.auth.kind !== "none" && !("optional" in p.auth && p.auth.optional)

const tokens = new Map<string, { token: string; until: number }>()
const FAILURES: Readonly<Record<CallFailure, string>> = {
  NOT_ALLOWED: "That address is not one of the provider's own.", NOT_PUBLIC: "The provider's address is not public.",
  AUTH: "The provider refused the business's credential. Reconnect it on the Channels page.", FORBIDDEN: "The provider refused this read for the connected account (permission, plan or quota).",
  NOT_FOUND: "Not found at the provider.", RATE_LIMITED: "The provider's rate limit was reached. Try again later.", REDIRECTED: "The provider redirected the request; OpenRecord does not follow redirects here.",
  INVALID_REQUEST: "The provider refused the request parameters.", UNAVAILABLE: "The provider did not answer.", MALFORMED: "The provider's answer could not be read.",
  NOT_CONFIGURED: "This provider needs server settings that are not configured (for example a declared contact).",
}

const runEndpoint = (e: AnyEndpoint, p: Provider) => (ctx: RunContext, input: unknown) => Effect.gen(function*() {
  const secret = p.auth.kind === "none" ? null : yield* credentialFor(ctx.businessId, p.id)
  if (needsCredential(p) && !secret) return refuse("NOT_CONNECTED", `${p.name} is not connected for this business. The team can add its own credential on the Channels page; until then this is unknown, not zero.`)
  const http = yield* transport
  let bearer: string | null = null
  if (p.auth.kind === "client_credentials" && secret) {
    const key = `${ctx.businessId}:${p.id}`, cached = tokens.get(key)
    bearer = cached && cached.until > Date.now() ? cached.token : yield* Effect.promise(() => clientToken(p, (p.auth as { tokenUrl: string }).tokenUrl, secret, http))
    if (!bearer) return refuse("AUTH", FAILURES.AUTH)
    tokens.set(key, { token: bearer, until: Date.now() + 50 * 60_000 })
  }
  const prepared = prepare(p, e.request(input, ctx.now), { secret, bearer }, process.env)
  if ("refused" in prepared) return refuse("NOT_CONFIGURED", FAILURES.NOT_CONFIGURED)
  const r = yield* Effect.promise(() => send(p, prepared, http))
  if (!r.ok) {
    if (r.failure === "NOT_FOUND") return { status: "NO_DATA", findings: {}, coverage: { provider: p.name, note: "The provider has no record for this. Unknown, not zero." } } satisfies Observed
    return refuse(r.failure === "AUTH" || r.failure === "FORBIDDEN" ? (r.failure === "AUTH" ? "RECONNECT_REQUIRED" : "FORBIDDEN") : r.failure,
      `${FAILURES[r.failure]}${r.retryAfterS !== null ? ` (retry after ${r.retryAfterS} seconds)` : ""}`)
  }
  const parsed = e.parse(r.json, input)
  if ("failed" in parsed) return refuse(parsed.failed, parsed.failed === "BALANCE_EXHAUSTED" ? "The business's provider account has no balance left." : parsed.failed === "AUTH" ? FAILURES.AUTH : "The provider reported that this request failed. Say it is unknown.")
  const { timeline, ...findings } = scrub(parsed.findings, [secret ?? "", bearer ?? ""]) as Record<string, unknown> & { timeline?: TimelineEvent[] }
  return { status: parsed.status, findings, ...(Array.isArray(timeline) ? { timeline } : {}),
    coverage: { provider: p.name, ...(parsed.coverage ?? {}), terms: p.note, docs: e.docs } } satisfies Observed
}) as Effect.Effect<Observed | Refused, unknown, SqlClient.SqlClient>

/** Every catalog endpoint as a research capability, run through run_research like the native ones. */
export const ENDPOINT_CAPABILITIES: ReadonlyArray<AnyCapability> = ENDPOINTS.flatMap(e => {
  const p = providerOf(e.provider)
  if (!p) return []
  const access = p.auth.kind === "none" ? "Public, no account." : needsCredential(p) ? `Needs the business's own ${p.name} connection${p.paid ? " (billed to that account)" : ""}.` : `Works without an account; the business's own ${p.name} credential raises limits.`
  return [{
    id: e.id, platform: e.platform, title: e.title, description: `${e.description} ${access}`, label: e.label, cache: e.cache ?? "day",
    source: p.auth.kind === "none" ? "PUBLIC_API" : "CONNECTED_ACCOUNT", input: e.input, subject: e.subject, run: runEndpoint(e, p),
    ...(needsCredential(p) ? { availability: (ctx: { businessId: string }) => Effect.map(credentialFor(ctx.businessId, p.id).pipe(Effect.orElseSucceed(() => null)), c => c ? null : `Needs the business's own ${p.name} connection on the Channels page`) } : {}),
    ...(p.headers && p.headers(process.env) === null ? { availability: () => Effect.succeed(`Needs the server setting RESEARCH_CONTACT (a declared contact ${p.name} requires)`) } : {}),
  } satisfies AnyCapability]
})

// ---------------------------------------------------------------- connections (Channels page)

const Connect = Schema.Struct({ credential: Schema.String.pipe(Schema.minLength(6), Schema.maxLength(400), Schema.pattern(/^[\x21-\x7e]+$/)) })
const listConnections = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT provider, credential_hint, status, connected_at FROM research_connections WHERE business_id = ${businessId}`
  const available = (yield* adsConfig).cipher !== null
  return { available, providers: CONNECTABLE.map(p => {
    const r = rows.find(x => x["provider"] === p.id)
    const on = r?.["status"] === "ACTIVE"
    return { id: p.id, name: p.name, how: p.connect!.how, url: p.connect!.url, example: p.connect!.example, paid: p.paid === true, optional: !needsCredential(p),
      endpoints: ENDPOINTS.filter(e => e.provider === p.id).map(e => e.title), connected: on, hint: on ? String(r!["credential_hint"]) : null, connectedAt: on ? new Date(r!["connected_at"] as string).toISOString() : null }
  }) }
})

export const researchConnectionsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const client = <E, R>(run: (session: Session, businessId: string, providerId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", providerId = params["provider"] ?? ""
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      return yield* run(session, businessId, providerId)
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "ConnectionsUnavailable" })))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/research-connections", client((_s, businessId) => Effect.flatMap(listConnections(businessId), b => json(200, b, { "cache-control": "no-store" })))),
    HttpRouter.put("/api/businesses/:id/research-connections/:provider", client((session, businessId, providerId) => Effect.gen(function*() {
      const p = CONNECTABLE.find(x => x.id === providerId)
      if (!p) return yield* json(404, { _tag: "ProviderNotFound" })
      const body = decode(Connect, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const credential = body.credential.trim()
      if (!p.connect!.format.test(credential)) return yield* json(422, { _tag: "CredentialFormat", example: p.connect!.example })
      const cipher = (yield* adsConfig).cipher
      if (!cipher) return yield* json(503, { _tag: "NotConfigured" })
      const sql = yield* SqlClient.SqlClient
      const hint = credential.replace(/[^A-Za-z0-9_-]/g, "").slice(-4)
      yield* sql`INSERT INTO research_connections(business_id, account_id, provider, credential_ciphertext, credential_hint, status, connected_by_user_id)
        VALUES (${businessId}, ${session.accountId}, ${p.id}, ${cipher.encrypt(credential, context(businessId, p.id))}, ${hint}, 'ACTIVE', ${session.userId})
        ON CONFLICT (business_id, provider) DO UPDATE SET credential_ciphertext = EXCLUDED.credential_ciphertext, credential_hint = EXCLUDED.credential_hint, status = 'ACTIVE',
          connected_by_user_id = EXCLUDED.connected_by_user_id, connected_at = now(), revoked_at = NULL WHERE research_connections.account_id = EXCLUDED.account_id`
      tokens.delete(`${businessId}:${p.id}`)
      return yield* json(200, yield* listConnections(businessId))
    }))),
    HttpRouter.del("/api/businesses/:id/research-connections/:provider", client((session, businessId, providerId) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE research_connections SET status = 'REVOKED', credential_ciphertext = NULL, revoked_at = now() WHERE business_id = ${businessId} AND account_id = ${session.accountId} AND provider = ${providerId} AND status = 'ACTIVE'`
      tokens.delete(`${businessId}:${providerId}`)
      return yield* json(200, yield* listConnections(businessId))
    }))),
  )
}
