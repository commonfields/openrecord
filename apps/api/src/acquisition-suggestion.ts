// What to measure in AI answers, gathered for the person to confirm: the
// competitors and buyer questions an accepted proposal suggested, else what
// the agent found when it drafted setup from the website, plus what is
// already frozen. Nothing here freezes a set or decides the authorization
// basis; the operator does both in AI Discovery.
import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { AgentProposalRepository, BusinessRepository, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

export interface AcquisitionSuggestion {
  readonly source: "PROPOSAL" | "SETUP" | null
  readonly brandName: string | null
  readonly category: string | null
  readonly domains: ReadonlyArray<string>
  readonly competitors: ReadonlyArray<{ readonly name: string; readonly website?: string }>
  readonly questions: ReadonlyArray<{ readonly group: string; readonly prompt: string }>
  /** Competitors in the newest frozen set: already confirmed by a person. */
  readonly confirmedCompetitors: ReadonlyArray<string>
  readonly hasFrozenSet: boolean
}

const host = (url: unknown) => { try { return typeof url === "string" ? new URL(url).hostname.replace(/^www\./, "") : null } catch { return null } }

export const acquisitionSuggestion = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const setup = (yield* sql`SELECT s.website_url, s.brief, s.draft, b.name FROM businesses b LEFT JOIN business_setups s ON s.business_id = b.id
    WHERE b.id = ${businessId} AND b.account_id = ${accountId}`)[0]
  const frozen = (yield* sql`SELECT competitors FROM acq_question_sets WHERE business_id = ${businessId} ORDER BY version DESC LIMIT 1`)[0]
  const proposals = yield* (yield* AgentProposalRepository).listByBusiness(accountId, businessId, null)
  const accepted = proposals.find(p => p.kind === "PROPOSE_QUESTION_SET" && (p.status === "APPROVED" || p.status === "PROPOSED") && p.payload)
  let evidence: { category?: unknown; questions?: unknown; competitors?: unknown } = {}
  try { evidence = accepted?.payload ? JSON.parse(accepted.payload.evidenceJson) as typeof evidence : {} } catch { evidence = {} }
  const brief = (setup?.["brief"] ?? null) as { businessName?: string; category?: string } | null
  const draft = (setup?.["draft"] ?? null) as { businessName?: string; category?: string; competitors?: Array<{ name: string; website?: string }> } | null
  const fromProposal = Array.isArray(evidence.questions) && evidence.questions.length > 0
  const competitors = (Array.isArray(evidence.competitors) ? evidence.competitors : draft?.competitors ?? []) as Array<{ name?: unknown; website?: unknown }>
  return {
    source: fromProposal ? "PROPOSAL" : draft || brief ? "SETUP" : null,
    brandName: brief?.businessName ?? draft?.businessName ?? (setup?.["name"] ? String(setup["name"]) : null),
    category: (typeof evidence.category === "string" ? evidence.category : null) ?? brief?.category ?? draft?.category ?? null,
    domains: [host(setup?.["website_url"])].filter((d): d is string => d !== null),
    competitors: competitors.flatMap(c => typeof c.name === "string" && c.name.trim() ? [{ name: c.name.trim().slice(0, 120), ...(typeof c.website === "string" ? { website: c.website.slice(0, 300) } : {}) }] : []).slice(0, 10),
    questions: fromProposal ? (evidence.questions as Array<{ group?: unknown; prompt?: unknown }>).flatMap(q => typeof q.group === "string" && typeof q.prompt === "string" ? [{ group: q.group, prompt: q.prompt.slice(0, 500) }] : []).slice(0, 60) : [],
    confirmedCompetitors: Array.isArray(frozen?.["competitors"]) ? (frozen["competitors"] as Array<{ name?: unknown }>).flatMap(c => typeof c.name === "string" ? [c.name] : []) : [],
    hasFrozenSet: frozen !== undefined,
  } satisfies AcquisitionSuggestion
})

export const acquisitionSuggestionApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/acquisition/suggestion", operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      return yield* json(200, { suggestion: yield* acquisitionSuggestion(session.accountId, businessId) }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(e => typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated"
      ? json(401, { _tag: "NotAuthenticated" }) : json(500, { _tag: "SuggestionFailed" })))),
  )
}
