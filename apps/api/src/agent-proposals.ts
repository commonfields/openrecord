import { agentOriginAllowed } from "./agent-origin.js"
// Agent proposal HTTP surface: human-gated execution of agent-suggested writes.
// Creation records intent and never executes; approval executes exactly once
// with the approver's session attribution; rejection decides without executing.
// Unknown and foreign ids both read as 404 without leaking which.
import { RecordSurfaceConfig } from "@openrecord/config"
import { recordFixtureAllowed } from "./record-routes.js"
import { loadProviderCatalog } from "./provider-catalog.js"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import type { SqlError } from "@effect/sql/SqlError"
import { Effect, Schema } from "effect"
import {
  AgentProposalRepository,
  AuthRepository,
  BusinessRepository,
  type AgentProposalStatus,
  type RowDecodeError,
  type Session,
} from "@openrecord/db"
import {
  ApproveAgentProposalRequest,
  CreateAgentProposalRequest,
  decodeRouteId,
} from "@openrecord/contracts"

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => HttpServerResponse.json(body, { status, headers })
const readJson = Effect.flatMap(HttpServerRequest.HttpServerRequest, (req) => req.json).pipe(Effect.catchAll(() => Effect.succeed(null)))
const decode = <A, I>(schema: Schema.Schema<A, I>, raw: unknown): A | null => {
  const decoded = Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(raw)
  return decoded._tag === "Right" ? decoded.right : null
}
const isUuid = (id: string): boolean => Schema.decodeUnknownEither(Schema.UUID)(id)._tag === "Right"

type WithSession = <A, E, R>(run: (session: Session) => Effect.Effect<A, E, R>) =>
  Effect.Effect<A, E | SqlError | RowDecodeError | { readonly _tag: "NotAuthenticated" }, R | AuthRepository | HttpServerRequest.HttpServerRequest>

const failure = (e: unknown) => {
  const tag = (e as { _tag?: string })?._tag
  if (tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  if (tag === "AcquisitionRefused" && typeof e === "object" && e !== null && "reason" in e) return json(409, { _tag: "AcquisitionRefused", reason: e.reason })
  if (tag === "AgentProposalRefused") {
    const reason = String((e as { reason?: unknown }).reason ?? "")
    if (reason === "ProposalNotFound" || reason === "BusinessNotFound" || reason === "QuestionNotFound") {
      return json(404, { _tag: "AgentProposalRefused", reason })
    }
    if (reason === "ProposalDecided") return json(409, { _tag: "AgentProposalRefused", reason })
    return json(422, { _tag: "AgentProposalRefused", reason })
  }
  if (tag === "SqlError" && /duplicate key|unique/i.test(String((e as { cause?: unknown }).cause ?? ""))) {
    return json(409, { _tag: "AgentProposalRefused", reason: "Conflict" })
  }
  return json(500, { _tag: "AgentProposalRequestFailed" })
}

export const agentProposalApi = (withSession: WithSession) => {
  const scoped = <E, R>(run: (s: Session, businessId: string, p: Record<string, string>) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    withSession((session: Session) =>
      Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.method !== "GET" && !(yield* agentOriginAllowed)) return yield* json(403, { _tag: "OriginRefused" })
        const { params } = yield* HttpRouter.RouteContext
        const p = params as Record<string, string>
        if (decodeRouteId(p["id"]!)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
        if (p["proposalId"] !== undefined && !isUuid(p["proposalId"]!)) return yield* json(422, { _tag: "InvalidRequest" })
        const business = yield* (yield* BusinessRepository).getScoped(session.accountId, p["id"]!)
        if (!business) return yield* json(404, { _tag: "BusinessNotFound" })
        return yield* run(session, business.id, p)
      })).pipe(Effect.catchAll(failure))

  return HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/businesses/:id/agent/proposals",
      scoped((session, businessId) =>
        Effect.gen(function*() {
          const request = yield* HttpServerRequest.HttpServerRequest
          const statusParam = new URL(request.url, "http://localhost").searchParams.get("status")
          const statuses = ["PROPOSED", "APPROVED", "EXECUTED", "REJECTED"] as const
          const status = statusParam === null ? null : statuses.find((s) => s === statusParam) ?? null
          if (statusParam !== null && status === null) return yield* json(422, { _tag: "InvalidRequest" })
          const proposals = yield* (yield* AgentProposalRepository).listByBusiness(session.accountId, businessId, status as AgentProposalStatus | null)
          return yield* json(200, { proposals })
        })),
    ),
    HttpRouter.post(
      "/api/businesses/:id/agent/proposals",
      scoped((session, businessId) =>
        Effect.gen(function*() {
          const body = decode(CreateAgentProposalRequest, yield* readJson)
          if (!body) return yield* json(422, { _tag: "InvalidRequest" })
          const proposal = yield* (yield* AgentProposalRepository).propose({
            accountId: session.accountId,
            businessId,
            kind: body.kind,
            questionId: body.questionId,
            message: "Operator-proposed re-check.",
            proposer: "operator",
            proposedByUserId: session.userId,
          })
          return yield* json(200, { proposal })
        })),
    ),
    HttpRouter.post(
      "/api/businesses/:id/agent/proposals/:proposalId/approve",
      scoped((session, businessId, p) =>
        Effect.gen(function*() {
          const body = decode(ApproveAgentProposalRequest, yield* readJson)
          if (!body) return yield* json(422, { _tag: "InvalidRequest" })
          const pId = p["proposalId"]!
          const pending = (yield* (yield* AgentProposalRepository).listByBusiness(session.accountId, businessId, null)).find(p => p.id === pId)
          if (!pending) return yield* json(404, { _tag: "AgentProposalRefused", reason: "ProposalNotFound" })
          if ("approveAcquisition" in body) {
            if (pending.kind !== "REQUEST_ACQUISITION_BATCH") return yield* json(422, { _tag: "InvalidRequest" })
            const surface = yield* RecordSurfaceConfig
            if (surface.provider === "mock" && !recordFixtureAllowed()) return yield* json(422, { _tag: "FixtureDisabled" })
            const proposal = yield* (yield* AgentProposalRepository).approveAcquisition(session.accountId, businessId, pId, session.userId,
              { provider: surface.provider, model: surface.provider === "mock" ? null : surface.model }, body.maxCostUsd)
            return yield* json(200, { proposal, acquisitionBatchId: proposal.executedAcquisitionBatchId })
          }
          if (pending.kind === "REQUEST_ACQUISITION_BATCH") return yield* json(422, { _tag: "InvalidRequest" })
          if ((pending.kind === "REQUEST_CHECK") === ("draftOnly" in body)) return yield* json(422, { _tag: "InvalidRequest" })
          if ("provider" in body && body.provider === "9router") {
            const catalog = yield* loadProviderCatalog(false, false)
            const provider = catalog.providers.find(p => p.id === "9router" && p.enabled)
            if (!body.requestedModel || !provider?.models.includes(body.requestedModel)) return yield* json(422, { _tag: "AgentProposalRefused", reason: "ModelUnavailable" })
          }
          const { proposal, checkRunId } = yield* (yield* AgentProposalRepository).approve(
            session.accountId,
            businessId,
            p["proposalId"]!,
            session.userId,
            "draftOnly" in body ? null : { provider: body.provider, requestedModel: body.requestedModel ?? null },
          )
          return yield* json(200, { proposal, checkRunId })
        })),
    ),
    HttpRouter.post(
      "/api/businesses/:id/agent/proposals/:proposalId/reject",
      scoped((session, businessId, p) =>
        Effect.gen(function*() {
          const proposal = yield* (yield* AgentProposalRepository).reject(session.accountId, businessId, p["proposalId"]!, session.userId)
          return yield* json(200, { proposal })
        })),
    ),
  )
}
