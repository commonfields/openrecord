// Agent proposals: the only agent write path, gated by human approval.
// A proposal records what was suggested, by whom (assistant draft vs
// operator), and for which business; nothing executes until the operator
// approves, and approval attributes execution to the approving session user.
// Concurrent approvals serialize on SELECT ... FOR UPDATE inside one
// transaction, so a double approval replays the single execution instead of
// duplicating it. A trigger backstops the single-decision rule.
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlError } from "@effect/sql/SqlError"
import {
  NullableTimestampField,
  NullableUuidField,
  TextField,
  TimestampField,
  UuidField,
  decodeRow,
  type RowDecodeError,
} from "./row-codecs.js"

export type ProposalEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | AgentProposalRefused>

export class AgentProposalRefused extends Data.TaggedError("AgentProposalRefused")<{ readonly reason: string }> {}

export type AgentProposalKind = "REQUEST_CHECK"
export type AgentProposalStatus = "PROPOSED" | "EXECUTED" | "REJECTED"
export type AgentProposer = "assistant-v1" | "operator"

export interface AgentProposal {
  readonly id: string
  readonly businessId: string
  readonly kind: AgentProposalKind
  readonly questionId: string | null
  readonly message: string
  readonly proposer: AgentProposer
  readonly proposedByUserId: string
  readonly status: AgentProposalStatus
  readonly decidedByUserId: string | null
  readonly decidedAt: string | null
  readonly executedCheckRunId: string | null
  readonly createdAt: string
}

const ProposalSchema = Schema.Struct({
  id: UuidField,
  business_id: UuidField,
  kind: TextField,
  question_id: NullableUuidField,
  message: TextField,
  proposer: TextField,
  proposed_by_user_id: UuidField,
  status: TextField,
  decided_by_user_id: NullableUuidField,
  decided_at: NullableTimestampField,
  executed_check_run_id: NullableUuidField,
  created_at: TimestampField,
})

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

const toProposal = (r: typeof ProposalSchema.Type): AgentProposal => ({
  id: r.id,
  businessId: r.business_id,
  kind: r.kind as AgentProposalKind,
  questionId: r.question_id,
  message: r.message,
  proposer: r.proposer as AgentProposer,
  proposedByUserId: r.proposed_by_user_id,
  status: r.status as AgentProposalStatus,
  decidedByUserId: r.decided_by_user_id,
  decidedAt: r.decided_at === null ? null : iso(r.decided_at),
  executedCheckRunId: r.executed_check_run_id,
  createdAt: iso(r.created_at),
})

export class AgentProposalRepository extends Context.Tag("AgentProposalRepository")<
  AgentProposalRepository,
  {
    readonly propose: (input: {
      accountId: string
      businessId: string
      kind: AgentProposalKind
      questionId: string | null
      message: string
      proposer: AgentProposer
      proposedByUserId: string
    }) => ProposalEffect<AgentProposal>
    readonly listByBusiness: (accountId: string, businessId: string, status: AgentProposalStatus | null) => ProposalEffect<ReadonlyArray<AgentProposal>>
    readonly approve: (
      accountId: string,
      businessId: string,
      proposalId: string,
      approverUserId: string,
      check: { provider: string; requestedModel: string | null },
    ) => ProposalEffect<{ proposal: AgentProposal; checkRunId: string }>
    readonly reject: (accountId: string, businessId: string, proposalId: string, approverUserId: string) => ProposalEffect<AgentProposal>
  }
>() {}

export const AgentProposalRepositoryLive = Layer.effect(
  AgentProposalRepository,
  Effect.map(PgClient.PgClient, (sql) => {
    const refuse = (reason: string) => Effect.fail(new AgentProposalRefused({ reason }))
    const scopedBusiness = (accountId: string, businessId: string) =>
      sql`SELECT 1 FROM businesses WHERE id = ${businessId} AND account_id = ${accountId}`.pipe(
        Effect.map((rows) => rows.length === 1),
      )
    const decodeProposal = (row: unknown) => decodeRow(ProposalSchema, "agent_proposals", row).pipe(Effect.map(toProposal))

    return {
      propose: (input) =>
        Effect.gen(function*() {
          if (!(yield* scopedBusiness(input.accountId, input.businessId))) return yield* refuse("BusinessNotFound")
          if (input.kind === "REQUEST_CHECK") {
            if (input.questionId === null) return yield* refuse("QuestionRequired")
            const scoped = yield* sql`SELECT 1 FROM buyer_questions WHERE id = ${input.questionId} AND business_id = ${input.businessId}`
            if (scoped.length === 0) return yield* refuse("QuestionNotFound")
          }
          // Re-proposing the same pending check returns the pending row
          // instead of spamming duplicates.
          const existing = (yield* sql`SELECT id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at FROM agent_proposals
            WHERE business_id = ${input.businessId} AND kind = ${input.kind}
              AND question_id IS NOT DISTINCT FROM ${input.questionId}::uuid AND status = 'PROPOSED'
            ORDER BY created_at LIMIT 1`) as Array<unknown>
          if (existing[0] !== undefined) return yield* decodeProposal(existing[0])
          return yield* sql`INSERT INTO agent_proposals (business_id, kind, question_id, message, proposer, proposed_by_user_id)
            VALUES (${input.businessId}, ${input.kind}, ${input.questionId}::uuid, ${input.message}, ${input.proposer}, ${input.proposedByUserId})
            RETURNING id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at`.pipe(
            Effect.flatMap((rows) => decodeProposal((rows as Array<unknown>)[0])),
            Effect.catchTag("SqlError", (e) =>
              /duplicate key|unique/i.test(e.message)
                ? sql`SELECT id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at FROM agent_proposals
                    WHERE business_id = ${input.businessId} AND kind = ${input.kind}
                      AND question_id IS NOT DISTINCT FROM ${input.questionId}::uuid AND status = 'PROPOSED'
                    ORDER BY created_at LIMIT 1`.pipe(
                    Effect.flatMap((rows) => decodeProposal((rows as Array<unknown>)[0])),
                  )
                : Effect.fail(e),
            ),
          )
        }),

      listByBusiness: (accountId, businessId, status) =>
        Effect.gen(function*() {
          if (!(yield* scopedBusiness(accountId, businessId))) return []
          const rows = (yield* sql`SELECT id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at FROM agent_proposals
            WHERE business_id = ${businessId} AND (${status}::text IS NULL OR status = ${status}::text)
            ORDER BY created_at DESC LIMIT 100`) as Array<unknown>
          return yield* Effect.forEach(rows, decodeProposal)
        }),

      approve: (accountId, businessId, proposalId, approverUserId, check) =>
        sql.withTransaction(
          Effect.gen(function*() {
            const locked = (yield* sql`SELECT id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at FROM agent_proposals
              WHERE id = ${proposalId} AND business_id = ${businessId} FOR UPDATE`) as Array<unknown>
            if (locked[0] === undefined) return yield* refuse("ProposalNotFound")
            if (!(yield* scopedBusiness(accountId, businessId))) return yield* refuse("ProposalNotFound")
            const current = yield* decodeProposal(locked[0])
            // Idempotent replay: an executed proposal returns its run.
            if (current.status === "EXECUTED") return { proposal: current, checkRunId: current.executedCheckRunId! }
            if (current.status === "REJECTED") return yield* refuse("ProposalDecided")
            if (Date.now() - Date.parse(current.createdAt) > 24 * 60 * 60 * 1000) return yield* refuse("ProposalExpired")
            if (current.kind === "REQUEST_CHECK") {
              if (current.questionId === null) return yield* refuse("QuestionRequired")
              const scoped = yield* sql`SELECT 1 FROM buyer_questions WHERE id = ${current.questionId} AND business_id = ${businessId}`
              if (scoped.length === 0) return yield* refuse("QuestionNotFound")
              const runs = (yield* sql`INSERT INTO check_runs (business_id, question_id, provider, requested_model)
                VALUES (${businessId}, ${current.questionId}, ${check.provider}, ${check.requestedModel}) RETURNING id`) as Array<Record<string, unknown>>
              const checkRunId = String(runs[0]!["id"])
              const updated = (yield* sql`UPDATE agent_proposals
                SET status = 'EXECUTED', decided_by_user_id = ${approverUserId}, decided_at = now(), executed_check_run_id = ${checkRunId}
                WHERE id = ${proposalId} RETURNING id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at`) as Array<unknown>
              return { proposal: yield* decodeProposal(updated[0]), checkRunId }
            }
            return yield* refuse("UnknownKind")
          }),
        ),

      reject: (accountId, businessId, proposalId, approverUserId) =>
        sql.withTransaction(
          Effect.gen(function*() {
            const locked = (yield* sql`SELECT id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at FROM agent_proposals
              WHERE id = ${proposalId} AND business_id = ${businessId} FOR UPDATE`) as Array<unknown>
            if (locked[0] === undefined) return yield* refuse("ProposalNotFound")
            if (!(yield* scopedBusiness(accountId, businessId))) return yield* refuse("ProposalNotFound")
            const current = yield* decodeProposal(locked[0])
            if (current.status === "EXECUTED") return yield* refuse("ProposalDecided")
            if (current.status === "REJECTED") return current
            const updated = (yield* sql`UPDATE agent_proposals
              SET status = 'REJECTED', decided_by_user_id = ${approverUserId}, decided_at = now()
              WHERE id = ${proposalId} RETURNING id, business_id, kind, question_id, message, proposer, proposed_by_user_id, status, decided_by_user_id, decided_at, executed_check_run_id, created_at`) as Array<unknown>
            return yield* decodeProposal(updated[0])
          }),
        ),
    }
  }),
)
