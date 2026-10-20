// W4 outcome evaluation read model. Reads, never writes: the initiative and
// its decision history (W0), the goal's immutable metric definition, the
// latest measurement plan and the resolved daily series (W3), and the
// execution ledger (W1), then hands them to the pure rules. No outcome is
// stored and no daily value is copied anywhere.
import { Context, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import { decodeRouteId, GrowthExecutionType, type GrowthOutcomeEvaluation, type GrowthSeries } from "@openrecord/contracts"
import { GrowthGoalDocument, GrowthRefused, GrowthRepository } from "./growth.js"
import { GrowthMeasurementRefused, GrowthMeasurementRepository, type GrowthMeasurementEffect } from "./growth-measurement.js"
import { decodeRow, iso } from "./row-codecs.js"
import { evaluateGrowthOutcome, type GrowthEvaluationActionRow } from "./growth-evaluation-rules.js"

/** Upper bound on listed ledger entries; the evaluation flags truncation. */
export const GROWTH_EVALUATION_ACTION_LIMIT = 200

const ActionRow = Schema.Struct({
  id: Schema.UUID, type: GrowthExecutionType, channel: Schema.NullOr(Schema.String), performedAt: Schema.String, recordedAt: Schema.String,
  assurance: Schema.Literal("OPERATOR_ATTESTED", "SYSTEM_VERIFIED", "UNSPECIFIED"), actor: Schema.String, reference: Schema.String,
  description: Schema.NullOr(Schema.String),
  verification: Schema.NullOr(Schema.Struct({ kind: Schema.String, id: Schema.String, claim: Schema.String })),
  association: Schema.Literal("THIS_INITIATIVE", "OTHER_INITIATIVE", "UNLINKED"),
  initiative: Schema.NullOr(Schema.Struct({ id: Schema.UUID, title: Schema.String })),
})

export class GrowthEvaluationRepository extends Context.Tag("GrowthEvaluationRepository")<GrowthEvaluationRepository, {
  readonly evaluate: (accountId: string, businessId: string, opportunityId: string) => GrowthMeasurementEffect<GrowthOutcomeEvaluation>
}>() {}

export const GrowthEvaluationRepositoryLive = Layer.effect(GrowthEvaluationRepository, Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const growth = yield* GrowthRepository
  const measurement = yield* GrowthMeasurementRepository
  const refuse = (reason: string) => Effect.fail(new GrowthMeasurementRefused({ reason }))
  const asMeasurement = <A, E>(effect: Effect.Effect<A, E | GrowthRefused>) =>
    effect.pipe(Effect.catchIf((e): e is GrowthRefused => e instanceof GrowthRefused, e => refuse(e.reason)))
  return {
    evaluate: (accountId, businessId, opportunityId) => Effect.gen(function*() {
      if (decodeRouteId(businessId)._tag === "Left" || decodeRouteId(opportunityId)._tag === "Left") return yield* refuse("InvalidRequest")
      // Scope (account → business → opportunity) is enforced by the W0 read.
      const opportunity = yield* asMeasurement(growth.get(accountId, businessId, opportunityId))
      const goalRows = yield* sql`SELECT document FROM growth_goal_documents WHERE id=${opportunity.goalId} AND business_id=${businessId}`
      if (!goalRows[0]) return yield* refuse("GrowthNotFound")
      const goal = yield* decodeRow(GrowthGoalDocument, "growth_goals", goalRows[0]["document"])
      const def = goal.metricDefinition
      const plan = yield* measurement.plan(accountId, businessId, opportunityId)
      const declarations = yield* sql`SELECT count(*)::int AS n FROM growth_measurement_plans WHERE opportunity_id=${opportunityId} AND business_id=${businessId}`
      const asOfRows = yield* sql`SELECT now() AS now`
      const asOf = iso(asOfRows[0]!["now"] as Date | string)
      const counted = def.countingSemantics === "EVENT_COUNT" && def.unit === "COUNT" && def.currency === null
      const period = plan ? { start: plan.plan.baselineStart, end: plan.plan.observationEnd } : null

      // Series are always read for the goal's own definition: a plan bound to a
      // different definition is reported by the rules, never read across.
      let baseline: GrowthSeries | null = null, observation: GrowthSeries | null = null
      if (plan && counted) {
        baseline = yield* measurement.series(accountId, businessId, def.id, plan.plan.baselineStart, plan.plan.baselineEnd)
        observation = yield* measurement.series(accountId, businessId, def.id, plan.plan.observationStart, plan.plan.observationEnd)
      }

      // Every current ledger entry in the planned period (calendar days in the
      // metric time zone, by performed time), plus all of this initiative's
      // own actions wherever they fall. Only the current head of each
      // correction chain is listed, attributed to the chain's initiative.
      const rows = yield* sql`SELECT i.id,i.type,i.channel,i.target,i.notes,i.performed_at,i.created_at,i.assurance,i.actor,
          i.verification_kind,i.verification_id,i.verification_claim,a.opportunity_id,o.title
        FROM interventions i
        -- A correction appended later supersedes the linked row; the initiative
        -- owns the whole chain (0030), so association follows the chain root.
        LEFT JOIN LATERAL (SELECT l.opportunity_id, l.business_id FROM growth_initiative_actions l
          WHERE l.business_id=i.business_id AND growth_intervention_chain_root(l.intervention_id)=growth_intervention_chain_root(i.id)
          ORDER BY l.created_at, l.intervention_id LIMIT 1) a ON true
        LEFT JOIN growth_opportunities o ON o.id=a.opportunity_id AND o.business_id=a.business_id
        WHERE i.business_id=${businessId}
          AND NOT EXISTS (SELECT 1 FROM interventions c WHERE c.supersedes_id=i.id)
          AND (a.opportunity_id=${opportunityId} OR (${period?.start ?? null}::date IS NOT NULL
            AND i.performed_at >= (${period?.start ?? null}::date)::timestamp AT TIME ZONE ${def.reportingTimeZone}
            AND i.performed_at < ((${period?.end ?? null}::date + 1)::timestamp AT TIME ZONE ${def.reportingTimeZone})))
        ORDER BY i.performed_at, i.created_at, i.id LIMIT ${GROWTH_EVALUATION_ACTION_LIMIT + 1}`
      const actions: ReadonlyArray<GrowthEvaluationActionRow> = yield* Effect.forEach(rows.slice(0, GROWTH_EVALUATION_ACTION_LIMIT), row => decodeRow(ActionRow, "interventions", {
        id: row["id"], type: row["type"], channel: row["channel"] ?? null,
        performedAt: iso(row["performed_at"] as Date | string), recordedAt: iso(row["created_at"] as Date | string),
        assurance: row["assurance"] ?? "UNSPECIFIED", actor: row["actor"], reference: row["target"], description: row["notes"] ?? null,
        verification: row["verification_kind"] == null ? null : { kind: row["verification_kind"], id: String(row["verification_id"]), claim: row["verification_claim"] },
        association: row["opportunity_id"] == null ? "UNLINKED" : row["opportunity_id"] === opportunityId ? "THIS_INITIATIVE" : "OTHER_INITIATIVE",
        initiative: row["opportunity_id"] == null ? null : { id: row["opportunity_id"], title: row["title"] },
      }))
      const excluded = period ? yield* sql`SELECT DISTINCT d.id, d.version, d.label FROM growth_metric_imports i
          JOIN growth_metric_definitions d ON d.id=i.metric_definition_id AND d.business_id=i.business_id
          WHERE i.business_id=${businessId} AND i.metric_definition_id<>${def.id}
            AND i.date_start <= ${period.end}::date AND i.date_end >= ${period.start}::date
          ORDER BY d.version, d.id` : []

      return evaluateGrowthOutcome({
        businessId, asOf,
        opportunity: { id: opportunity.id, title: opportunity.title, goalId: opportunity.goalId, status: opportunity.status, revision: opportunity.revision, events: opportunity.events },
        goal, plan, planDeclarations: Number(declarations[0]?.["n"] ?? 0), baseline, observation,
        actions, actionsTruncated: rows.length > GROWTH_EVALUATION_ACTION_LIMIT,
        excludedDefinitions: excluded.map(r => ({ id: String(r["id"]), version: Number(r["version"]), label: String(r["label"]) })),
      })
    }),
  } satisfies Context.Tag.Service<GrowthEvaluationRepository>
}))
