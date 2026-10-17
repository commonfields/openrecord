// AI Discovery (OPENRECORD_AI_ACQUISITION_PILOT_V1) HTTP surface. Operator
// routes only: session-scoped to the agency account, origin-checked writes,
// every human act attributed to the session user, request bodies never carry
// identities. There is no public route: unreviewed acquisition findings are
// never published, and the report is an authenticated operator document.
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import {
  ACQ_INTENT_GROUPS, ACQ_MAX_ATTEMPTS_PER_CHECK, AcquisitionRepository, BusinessRepository, acquisitionReport, acquisitionView,
  type AcquisitionRefused, type Session,
} from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { RecordSurfaceConfig } from "@openrecord/config"
import { Text, decode, json, operatorSessionFor, readJson, recordFixtureAllowed, type WithSession } from "./record-routes.js"

const Brand = Schema.Struct({
  name: Text(120),
  aliases: Schema.Array(Schema.String.pipe(Schema.maxLength(120))).pipe(Schema.maxItems(20)),
  domains: Schema.Array(Schema.String.pipe(Schema.maxLength(253))).pipe(Schema.maxItems(10)),
  matchCase: Schema.optional(Schema.Boolean),
  ambiguity: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(300)))),
})
const CreateSetRequest = Schema.Struct({
  basis: Schema.Literal("AUTHORIZED_CLIENT", "PUBLIC_RESEARCH", "FIXTURE"),
  category: Text(200),
  target: Brand,
  competitors: Schema.Array(Brand).pipe(Schema.maxItems(15)),
  questions: Schema.Array(Schema.Struct({ group: Schema.Literal(...ACQ_INTENT_GROUPS), prompt: Text(500) })).pipe(Schema.minItems(1), Schema.maxItems(60)),
})
const StartBatchRequest = Schema.Struct({
  setId: Schema.UUID,
  scope: Schema.Literal("SMOKE", "FULL"),
  questionKeys: Schema.optional(Schema.Array(Schema.String.pipe(Schema.pattern(/^[A-Z]{2}-[0-9]{2}$/))).pipe(Schema.maxItems(60))),
  samples: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(5)),
  acknowledgedMaxProviderCalls: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
})
const JudgeRequest = Schema.Struct({
  observationId: Schema.UUID,
  mention: Schema.Literal("MENTIONED", "NOT_MENTIONED", "UNCLEAR"),
  recommendation: Schema.NullOr(Schema.Literal("RECOMMENDED", "MENTIONED_NOT_RECOMMENDED", "ADVISED_AGAINST", "UNCLEAR")),
  note: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(2000)))),
})
const Day = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/))
const ImportRequest = Schema.Struct({
  dataOrigin: Schema.Literal("GA4_EXPORT", "SYNTHETIC_FIXTURE"),
  propertyRef: Text(120),
  dateStart: Day,
  dateEnd: Day,
  timeZone: Text(64),
  attributionBasis: Schema.Literal("SESSION_SOURCE_MEDIUM"),
  conversionEvent: Schema.NullOr(Schema.String.pipe(Schema.maxLength(100))),
  csv: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_048_576)),
})

const failure = (e: unknown) => {
  const tag = (e as { _tag?: string })?._tag
  if (tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  if (tag === "AcquisitionRefused") {
    const { reason, line } = e as AcquisitionRefused
    return json(reason.endsWith("NotFound") ? 404 : 409, { _tag: "AcquisitionRefused", reason, line: line ?? null })
  }
  if (tag === "SqlError" && /duplicate key|unique/i.test(String((e as { cause?: unknown }).cause ?? ""))) return json(409, { _tag: "AcquisitionRefused", reason: "Conflict", line: null })
  return json(500, { _tag: "AcquisitionRequestFailed" })
}

export const acquisitionApi = (withSession: WithSession) => {
  const operatorSession = operatorSessionFor(withSession)
  /** Business scoped to the session's agency account. */
  const client = <E, R>(run: (s: Session, businessId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operatorSession((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const id = (params as Record<string, string>)["id"] ?? ""
      if (decodeRouteId(id)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      const business = yield* (yield* BusinessRepository).getScoped(session.accountId, id)
      if (!business) return yield* json(404, { _tag: "ClientNotFound" })
      return yield* run(session, business.id)
    })).pipe(Effect.catchAll(failure))
  const snapshot = (businessId: string) => Effect.flatMap(AcquisitionRepository, r => r.snapshot(businessId))
  const view = (businessId: string) => Effect.gen(function*() {
    const s = yield* snapshot(businessId)
    if (s === null) return yield* json(404, { _tag: "ClientNotFound" })
    const surface = yield* RecordSurfaceConfig
    return yield* json(200, { view: acquisitionView(s), surface: { provider: surface.provider, model: surface.model }, maxAttemptsPerCheck: ACQ_MAX_ATTEMPTS_PER_CHECK })
  })

  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/acquisition/clients/:id", client((_, businessId) => view(businessId))),
    HttpRouter.get("/api/acquisition/clients/:id/report", client((_, businessId) => Effect.gen(function*() {
      const s = yield* snapshot(businessId)
      if (s === null) return yield* json(404, { _tag: "ClientNotFound" })
      return yield* json(200, { report: acquisitionReport(s) }, { "cache-control": "no-store" })
    }))),
    HttpRouter.post("/api/acquisition/clients/:id/question-sets", client((session, businessId) => Effect.gen(function*() {
      const body = decode(CreateSetRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      if (body.basis === "FIXTURE" && !recordFixtureAllowed()) return yield* json(422, { _tag: "FixtureDisabled" })
      const brand = (b: typeof Brand.Type) => ({ name: b.name, aliases: b.aliases, domains: b.domains, matchCase: b.matchCase ?? false, ambiguity: b.ambiguity ?? null })
      const set = yield* (yield* AcquisitionRepository).createQuestionSet(session, businessId, {
        basis: body.basis, category: body.category, target: brand(body.target), competitors: body.competitors.map(brand), questions: body.questions,
      })
      return yield* json(200, { set })
    }))),
    HttpRouter.post("/api/acquisition/clients/:id/batches", client((session, businessId) => Effect.gen(function*() {
      const body = decode(StartBatchRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const surface = yield* RecordSurfaceConfig
      if (surface.provider === "mock" && !recordFixtureAllowed()) return yield* json(409, { _tag: "AcquisitionRefused", reason: "FixtureProviderDisabled", line: null })
      const batch = yield* (yield* AcquisitionRepository).startBatch(session, businessId, {
        setId: body.setId, scope: body.scope, questionKeys: body.questionKeys ?? null, samples: body.samples,
        provider: surface.provider, requestedModel: surface.provider === "gemini" ? surface.model : null,
        acknowledgedMaxProviderCalls: body.acknowledgedMaxProviderCalls,
      })
      return yield* json(200, { batch })
    }))),
    HttpRouter.post("/api/acquisition/clients/:id/judgments", client((session, businessId) => Effect.gen(function*() {
      const body = decode(JudgeRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const note = body.note?.trim() ? body.note.trim() : null
      const judgment = yield* (yield* AcquisitionRepository).judge(session, businessId, { observationId: body.observationId, mention: body.mention,
        recommendation: body.recommendation, note })
      return yield* json(200, { judgment })
    }))),
    HttpRouter.post("/api/acquisition/clients/:id/referral-imports", client((session, businessId) => Effect.gen(function*() {
      const body = decode(ImportRequest, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      if (body.dataOrigin === "SYNTHETIC_FIXTURE" && !recordFixtureAllowed()) return yield* json(422, { _tag: "FixtureDisabled" })
      const conversionEvent = body.conversionEvent?.trim() ? body.conversionEvent.trim() : null
      const result = yield* (yield* AcquisitionRepository).importReferrals(session, businessId, {
        dataOrigin: body.dataOrigin, propertyRef: body.propertyRef, dateStart: body.dateStart, dateEnd: body.dateEnd, timeZone: body.timeZone.trim(),
        attributionBasis: body.attributionBasis, conversionEvent,
      }, body.csv)
      return yield* json(200, result)
    }))),
  )
}
