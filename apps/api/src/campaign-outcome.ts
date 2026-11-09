import { createHash } from "node:crypto"
import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { BusinessRepository, GrowthEvaluationRepository, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { Data, Effect, JSONSchema, Option, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { decode, json, operatorSessionFor, readJson, Text, type WithSession } from "./record-routes.js"

/**
 * M2: a campaign WEBSITE deliverable, its exact WordPress change, the predeclared plan of an approved
 * opportunity, and the observed outcome. Bindings are append-only rows; the outcome is derived on read.
 * Descriptive only: no lift, attribution or success label. "Unproven" is a valid result.
 */
export class CampaignMeasurementRefused extends Data.TaggedError("CampaignMeasurementRefused")<{ reason: string; bindingId?: string }> {}
const refuse = (reason: string, bindingId?: string) => Effect.fail(new CampaignMeasurementRefused(bindingId ? { reason, bindingId } : { reason }))

const BindInput = Schema.Struct({ runId: Schema.UUID, taskId: Schema.UUID, opportunityId: Schema.UUID, planId: Schema.UUID })
const OutcomeInput = Schema.Struct({ campaignId: Schema.UUID })
const DissolveInput = Schema.Struct({ reason: Text(1000) })
const PRIVATE = { "cache-control": "no-store" }

export const CAMPAIGN_OUTCOME_STATES = ["NOT_BOUND", "AWAITING_DELIVERY", "AWAITING_APPROVAL", "APPROVED_VALUES_CHANGED", "DELIVERY_UNVERIFIED",
  "AWAITING_OBSERVATION_WINDOW", "OBSERVED"] as const
export type CampaignOutcomeState = typeof CAMPAIGN_OUTCOME_STATES[number]

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})

export const campaignOutcomeDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "record_campaign_measurement", description: "Bind one WEBSITE deliverable of the current campaign run to an operator-approved growth opportunity of the campaign's goal and that opportunity's latest predeclared measurement plan. Do this before the deliverable's WordPress change is approved: binding after delivery was decided is refused, so measurement is never chosen after seeing results. Read read_growth_opportunities and the plan first. Repeating the same binding reuses it; a different binding for an already bound deliverable is refused, never replaced (an operator may dissolve it). Several deliverables may share one plan. Grants no approval and measures nothing by itself.", parametersJsonSchema: JSONSchema.make(BindInput) },
  { name: "read_campaign_outcome", description: "Read each WEBSITE deliverable of a campaign's latest run along its chain: measurement binding, exact linked WordPress change, operator approval, verified publication, plan timing and, once the observation window has passed, the descriptive before/after reading of the goal metric. States: NOT_BOUND, AWAITING_DELIVERY, AWAITING_APPROVAL, APPROVED_VALUES_CHANGED, DELIVERY_UNVERIFIED, AWAITING_OBSERVATION_WINDOW, OBSERVED. OBSERVED is a measurement-quality reading, never lift, attribution or success; say 'unproven' when the reading cannot support a conclusion. Read-only.", parametersJsonSchema: JSONSchema.make(OutcomeInput) },
]

export const bindCampaignMeasurement = (ctx: ToolContext, raw: unknown, actor: "ASSISTANT" | "OPERATOR" = "ASSISTANT") => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(BindInput, { onExcessProperty: "error" })(raw)
  yield* scoped(ctx.accountId, ctx.businessId)
  const sql = yield* SqlClient.SqlClient
  const key = createHash("sha256").update(JSON.stringify(["campaign-measurement-v1", ctx.userId, input.runId, input.taskId, input.opportunityId, input.planId])).digest("hex")
  const saved = yield* sql.withTransaction(Effect.gen(function*() {
    // Same lock order as delivery links: campaign, then run.
    const run = (yield* sql`SELECT r.campaign_id,r.campaign_revision,r.snapshot,r.cancelled_at,c.revision,c.objective_goal_id FROM marketing_campaign_runs r
      JOIN marketing_campaigns c ON c.id=r.campaign_id AND c.business_id=r.business_id
      WHERE r.id=${input.runId} AND r.business_id=${ctx.businessId} FOR UPDATE OF c,r`)[0]
    if (!run) return yield* Effect.fail(new AgentNotInScope())
    const replay = (yield* sql`SELECT id FROM marketing_campaign_measurement_bindings WHERE business_id=${ctx.businessId} AND request_key=${key}`)[0]
    if (replay) return { id: String(replay["id"]), reused: true }
    const active = (yield* sql`SELECT id,opportunity_id,plan_id FROM marketing_campaign_measurement_bindings
      WHERE run_id=${input.runId} AND task_id=${input.taskId} AND dissolved_at IS NULL`)[0]
    if (active) {
      if (active["opportunity_id"] === input.opportunityId && active["plan_id"] === input.planId) return { id: String(active["id"]), reused: true }
      return yield* refuse("MeasurementAlreadyBound", String(active["id"]))
    }
    if (run["cancelled_at"]) return yield* refuse("CampaignRunCancelled")
    if (Number(run["revision"]) !== Number(run["campaign_revision"])) return yield* refuse("StaleCampaignRun")
    const tasks = ((run["snapshot"] as { tasks?: Array<{ id: string; channel: string }> }).tasks ?? [])
    if (!tasks.some(t => t.id === input.taskId && t.channel === "WEBSITE")) return yield* refuse("UnsupportedDeliverable")
    if (!run["objective_goal_id"]) return yield* refuse("CampaignObjectiveUnknown")
    const opportunity = (yield* sql`SELECT o.goal_id, growth_opportunity_status(o.id) AS status FROM growth_opportunities o
      WHERE o.id=${input.opportunityId} AND o.business_id=${ctx.businessId}`)[0]
    if (!opportunity) return yield* Effect.fail(new AgentNotInScope())
    if (opportunity["status"] !== "APPROVED") return yield* refuse("OpportunityNotApproved")
    if (opportunity["goal_id"] !== run["objective_goal_id"]) return yield* refuse("ObjectiveMismatch")
    const latest = (yield* sql`SELECT id FROM growth_measurement_plans WHERE opportunity_id=${input.opportunityId} AND business_id=${ctx.businessId}
      ORDER BY declared_at DESC, id DESC LIMIT 1`)[0]
    if (!latest) return yield* refuse("NoMeasurementPlan")
    if (latest["id"] !== input.planId) return yield* refuse("PlanNotLatest")
    const decided = (yield* sql`SELECT 1 FROM marketing_campaign_deliveries d JOIN wordpress_changes w ON w.id=d.wordpress_change_id
      WHERE d.run_id=${input.runId} AND d.task_id=${input.taskId} AND (w.status<>'PROPOSED' OR w.decided_at IS NOT NULL)`)[0]
    if (decided) return yield* refuse("DeliveryAlreadyDecided")
    const rows = yield* sql`INSERT INTO marketing_campaign_measurement_bindings(business_id,campaign_id,run_id,task_id,opportunity_id,plan_id,request_key,
        bound_by_user_id,bound_by_actor,origin_provider,origin_model)
      VALUES (${ctx.businessId},${run["campaign_id"]},${input.runId},${input.taskId},${input.opportunityId},${input.planId},${key},
        ${ctx.userId},${actor},${ctx.origin?.provider.slice(0, 200) ?? null},${ctx.origin?.model.slice(0, 200) ?? null}) RETURNING id`
    return { id: String(rows[0]!["id"]), reused: false }
  }))
  return { summary: saved.reused ? "Existing measurement binding reused" : "Deliverable bound to a predeclared measurement plan; nothing measured yet", citations: [],
    data: { bindingId: saved.id, reused: saved.reused, executed: false,
      note: "The binding names how this deliverable will be judged. It is not approval, delivery or an outcome. Read read_campaign_outcome for its chain." } }
})

interface ChainRow {
  readonly task_id: string; readonly binding_id: string | null; readonly opportunity_id: string | null; readonly plan_id: string | null
  readonly bound_at: Date | null; readonly bound_by_actor: string | null; readonly dissolved_bindings: number
  readonly change_id: string | null; readonly prepared_digest: string | null; readonly digest_now: string | null; readonly change_status: string | null
  readonly decided_at: Date | null; readonly published_at: Date | null; readonly live_observed: boolean | null
  readonly declared_at: Date | null; readonly baseline_start: string | null; readonly baseline_end: string | null
  readonly observation_start: string | null; readonly observation_end: string | null; readonly today: string | null; readonly delivery_day: string | null
}

export const readCampaignOutcome = (accountId: string, businessId: string, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(OutcomeInput, { onExcessProperty: "error" })(raw)
  yield* scoped(accountId, businessId)
  const sql = yield* SqlClient.SqlClient
  const run = (yield* sql`SELECT r.id,r.campaign_revision,r.snapshot,r.cancelled_at,c.revision,c.objective_goal_id FROM marketing_campaign_runs r
    JOIN marketing_campaigns c ON c.id=r.campaign_id AND c.business_id=r.business_id
    WHERE r.business_id=${businessId} AND r.campaign_id=${input.campaignId} ORDER BY r.campaign_revision DESC LIMIT 1`)[0]
  if (!run) {
    if (!(yield* sql`SELECT 1 FROM marketing_campaigns WHERE id=${input.campaignId} AND business_id=${businessId}`)[0]) return yield* Effect.fail(new AgentNotInScope())
    return { summary: "No campaign run yet, so no deliverable chain", citations: [], data: { campaignId: input.campaignId, run: null, deliverables: [] } }
  }
  const tasks = ((run["snapshot"] as { tasks?: Array<{ id: string; title: string; channel: string }> }).tasks ?? [])
    .filter(t => t.channel === "WEBSITE" && /^[0-9a-f-]{36}$/i.test(t.id))
  const rows = tasks.length ? yield* sql<ChainRow>`SELECT t.task_id, b.id AS binding_id, b.opportunity_id, b.plan_id, b.bound_at, b.bound_by_actor,
      (SELECT count(*)::int FROM marketing_campaign_measurement_bindings x WHERE x.run_id=${run["id"]} AND x.task_id=t.task_id AND x.dissolved_at IS NOT NULL) AS dissolved_bindings,
      d.wordpress_change_id AS change_id, d.prepared_digest, wordpress_prepared_digest(w.after_values) AS digest_now, w.status AS change_status,
      w.decided_at, w.published_at, (w.live_check->>'observed')::boolean AS live_observed,
      p.declared_at, p.baseline_start::text, p.baseline_end::text, p.observation_start::text, p.observation_end::text,
      (now() AT TIME ZONE md.reporting_time_zone)::date::text AS today, (w.published_at AT TIME ZONE md.reporting_time_zone)::date::text AS delivery_day
    FROM unnest(${`{${tasks.map(t => t.id).join(",")}}`}::uuid[]) AS t(task_id)
    LEFT JOIN marketing_campaign_measurement_bindings b ON b.run_id=${run["id"]} AND b.task_id=t.task_id AND b.business_id=${businessId} AND b.dissolved_at IS NULL
    LEFT JOIN growth_measurement_plans p ON p.id=b.plan_id AND p.business_id=b.business_id
    LEFT JOIN growth_metric_definitions md ON md.id=p.metric_definition_id AND md.business_id=p.business_id
    LEFT JOIN marketing_campaign_deliveries d ON d.run_id=${run["id"]} AND d.task_id=t.task_id AND d.business_id=${businessId}
    LEFT JOIN wordpress_changes w ON w.id=d.wordpress_change_id AND w.business_id=d.business_id` : []
  const evaluations = yield* Effect.serviceOption(GrowthEvaluationRepository)
  const deliverables = []
  for (const task of tasks) {
    const r = rows.find(x => x.task_id === task.id)!
    const iso = (d: Date | null) => d ? new Date(d).toISOString() : null
    const binding = r.binding_id ? { id: r.binding_id, opportunityId: r.opportunity_id, planId: r.plan_id, boundAt: iso(r.bound_at), boundBy: r.bound_by_actor } : null
    const delivery = r.change_id ? { wordpressChangeId: r.change_id, status: r.change_status, decidedAt: iso(r.decided_at), publishedAt: iso(r.published_at),
      liveObserved: r.live_observed, valuesPinned: r.prepared_digest !== null, valuesUnchanged: r.prepared_digest !== null && r.prepared_digest === r.digest_now } : null
    const predeclared = r.declared_at && r.published_at && r.bound_at && r.decided_at
      ? new Date(r.declared_at) < new Date(r.published_at) && new Date(r.bound_at) <= new Date(r.decided_at) : null
    const windows = r.baseline_start ? { baselineStart: r.baseline_start, baselineEnd: r.baseline_end, observationStart: r.observation_start, observationEnd: r.observation_end } : null
    // Delivery should fall after the baseline and no later than the observation start, or the windows do not straddle it.
    const aligned = r.delivery_day && r.baseline_end && r.observation_start ? r.delivery_day > r.baseline_end && r.delivery_day <= r.observation_start : null
    const [state, reason]: [CampaignOutcomeState, string] = !binding ? ["NOT_BOUND", "NO_MEASUREMENT_BINDING"]
      : !delivery ? ["AWAITING_DELIVERY", "NO_DELIVERY_LINK"]
      : !delivery.valuesPinned ? ["DELIVERY_UNVERIFIED", "LEGACY_LINK_WITHOUT_PINNED_VALUES"]
      : !delivery.valuesUnchanged ? ["APPROVED_VALUES_CHANGED", "LINKED_VALUES_DIFFER_FROM_PINNED"]
      : delivery.status === "PROPOSED" ? ["AWAITING_APPROVAL", "OPERATOR_DECISION_PENDING"]
      : delivery.status === "PUBLISHING" ? ["AWAITING_DELIVERY", "PUBLISHING"]
      : delivery.status !== "PUBLISHED" ? ["DELIVERY_UNVERIFIED", `CHANGE_${delivery.status}`]
      : delivery.liveObserved !== true ? ["DELIVERY_UNVERIFIED", "LIVE_CHECK_NOT_OBSERVED"]
      : r.today !== null && r.observation_end !== null && r.today <= r.observation_end ? ["AWAITING_OBSERVATION_WINDOW", "OBSERVATION_WINDOW_OPEN"]
      : ["OBSERVED", "OBSERVATION_WINDOW_CLOSED"]
    let reading: unknown = null
    if (state === "OBSERVED" && r.opportunity_id && Option.isSome(evaluations)) {
      reading = yield* evaluations.value.evaluate(accountId, businessId, r.opportunity_id).pipe(
        Effect.map(e => ({ status: e.status, interpretation: e.interpretation, reasons: e.reasons, caveats: e.caveats, comparison: e.comparison,
          baseline: e.baseline && { coverage: e.baseline.coverage, validDays: e.baseline.validDays, days: e.baseline.days, dailyMean: e.baseline.dailyMean },
          observation: e.observation && { coverage: e.observation.coverage, validDays: e.observation.validDays, days: e.observation.days, dailyMean: e.observation.dailyMean },
          limitations: e.limitations })),
        Effect.orElseSucceed(() => ({ status: "UNAVAILABLE", note: "The evaluation could not be read. Do not claim an outcome." })))
    }
    deliverables.push({ taskId: task.id, title: task.title, state, reason, binding, dissolvedBindings: r.dissolved_bindings, delivery, windows,
      timing: { planPredeclared: predeclared, deliveryDay: r.delivery_day, windowsStraddleDelivery: aligned }, reading })
  }
  return { summary: `${deliverables.length} website deliverables read`, citations: [], data: {
    campaignId: input.campaignId, run: { id: run["id"], campaignRevision: Number(run["campaign_revision"]), stale: Number(run["revision"]) !== Number(run["campaign_revision"]), cancelled: Boolean(run["cancelled_at"]) },
    deliverables,
    note: "Each state is derived from records: the binding, the pinned WordPress change, the operator's approval, the adapter's publication and live check, and the predeclared plan. OBSERVED carries a descriptive before/after reading only; it never establishes lift, attribution or success, and windowsStraddleDelivery false or planPredeclared false weakens it further. Unproven is a valid conclusion. Keep, revert or extend decisions remain the operator's.",
  } }
})

export const dispatchCampaignOutcome = (ctx: ToolContext, name: string, raw: unknown) =>
  name === "record_campaign_measurement" ? bindCampaignMeasurement(ctx, raw) : readCampaignOutcome(ctx.accountId, ctx.businessId, raw)

/** Operator routes: read the chain and dissolve a binding. The agent has no dissolve tool. */
export const campaignOutcomeApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const handled = <E, R>(run: (session: Session, params: Readonly<Record<string, string | undefined>>) => Effect.Effect<import("@effect/platform/HttpServerResponse").HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      for (const id of [params["id"], params["campaignId"], params["bindingId"]]) if (id !== undefined && decodeRouteId(id)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, params["id"] ?? ""))) return yield* json(404, { _tag: "NotFound" })
      return yield* run(session, params)
    })).pipe(Effect.catchAll(e => {
      const tag = typeof e === "object" && e !== null && "_tag" in e ? String(e._tag) : ""
      return tag === "NotAuthenticated" ? json(401, { _tag: tag }) : tag === "AgentNotInScope" ? json(404, { _tag: "NotFound" }) : json(500, { _tag: "CampaignOutcomeFailed" })
    }))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/campaigns/:campaignId/outcome", handled((session, params) => Effect.gen(function*() {
      return yield* json(200, (yield* readCampaignOutcome(session.accountId, params["id"]!, { campaignId: params["campaignId"] })).data, PRIVATE)
    }))),
    HttpRouter.post("/api/businesses/:id/campaign-measurement-bindings/:bindingId/dissolve", handled((session, params) => Effect.gen(function*() {
      const input = decode(DissolveInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      const done = (yield* sql`UPDATE marketing_campaign_measurement_bindings SET dissolved_at=now(), dissolved_by_user_id=${session.userId}, dissolution_reason=${input.reason}
        WHERE id=${params["bindingId"]!} AND business_id=${params["id"]!} AND dissolved_at IS NULL RETURNING id, dissolved_at`)[0]
      if (done) return yield* json(200, { binding: { id: done["id"], dissolvedAt: done["dissolved_at"] } }, PRIVATE)
      const exists = (yield* sql`SELECT dissolved_at FROM marketing_campaign_measurement_bindings WHERE id=${params["bindingId"]!} AND business_id=${params["id"]!}`)[0]
      return exists ? yield* json(409, { _tag: "AlreadyDissolved" }, PRIVATE) : yield* json(404, { _tag: "NotFound" }, PRIVATE)
    }))),
  )
}
