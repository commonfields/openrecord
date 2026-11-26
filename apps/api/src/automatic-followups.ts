// Follow-ups without switching them on. A business someone has worked in over
// the last 30 days gets an automatic follow-up policy: the agent revisits its
// waiting investigations and campaign milestones (a page going live, the first
// inquiry, a review date) on its own, within the same daily budget and with the
// same read-only tools as a granted policy. Each wake runs on the model that
// works at the time, never a pinned one that has gone away. Turning follow-ups
// off for the business is recorded apart from the policy and always respected;
// a person's own choice of chat and model replaces the automatic policy.
import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import type { HarnessSelection } from "@openrecord/contracts"
import { Effect } from "effect"
import { AgentModelError, configuredAgentModel } from "./agent-model.js"
import { harnessModel } from "./harness-model.js"
import { resolveUnattendedSelection } from "./harness-selection.js"
import { lastChatSelection } from "./unattended-agent.js"
import { isDemoBusiness } from "./demo-data.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

/** Written on an automatic policy in place of a granted provider and model. */
export const AUTOMATIC_MODEL = "automatic"
/** Policies created per pass, so a large workspace is covered over a few passes. */
const PER_PASS = 20

/**
 * Gives each active business an automatic policy. Active: a person sent the
 * agent a request there in the last 30 days and is still in the account, and
 * the business is not archived or sample data. A wake still needs something to
 * revisit: a waiting investigation or a campaign milestone. Skipped when the
 * business has any policy already or follow-ups were turned off for it. Also
 * keeps automatic policies' chats from expiring, which would delete them.
 */
export const ensureAutomaticFollowups = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE agent_conversations c SET expires_at = greatest(c.expires_at, now() + interval '30 days')
    FROM growth_investigation_wake_policies p WHERE p.automatic AND p.conversation_id = c.id AND c.expires_at < now() + interval '7 days'`
  const candidates = yield* sql`SELECT DISTINCT ON (j.business_id) j.account_id, j.user_id, j.business_id
    FROM agent_request_jobs j
    JOIN account_users u ON u.account_id=j.account_id AND u.user_id=j.user_id
    JOIN businesses b ON b.id=j.business_id AND b.account_id=j.account_id AND b.archived_at IS NULL
    WHERE j.business_id IS NOT NULL AND j.continues_request_id IS NULL AND j.created_at > now() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM growth_investigation_wake_policies p WHERE p.business_id=j.business_id)
      AND NOT EXISTS (SELECT 1 FROM agent_followup_pauses x WHERE x.business_id=j.business_id)
    ORDER BY j.business_id, j.created_at DESC LIMIT ${PER_PASS * 2}`
  let created = 0
  for (const row of candidates) {
    const scope: Scope = { accountId: String(row["account_id"]), userId: String(row["user_id"]), businessId: String(row["business_id"]) }
    if (isDemoBusiness(scope.businessId) || created >= PER_PASS) continue
    const made = yield* sql.withTransaction(Effect.gen(function*() {
      // The same lock follow-up claims take, so a policy never appears halfway through a claim.
      yield* sql`SELECT pg_advisory_xact_lock(703941207)`
      const taken = yield* sql`SELECT 1 FROM growth_investigation_wake_policies WHERE business_id=${scope.businessId}
        UNION ALL SELECT 1 FROM agent_followup_pauses WHERE business_id=${scope.businessId}`
      if (taken.length) return false
      const conversationId = randomUUID()
      yield* sql`INSERT INTO agent_conversations(id, account_id, business_id, user_id, archived_at, last_reply)
        VALUES (${conversationId}, ${scope.accountId}, ${scope.businessId}, ${scope.userId}, now(), ${JSON.stringify({ title: "Follow-ups" })}::jsonb)`
      const rows = yield* sql`INSERT INTO growth_investigation_wake_policies(account_id,user_id,business_id,conversation_id,grant_id,enabled,selection,provider,model,automatic)
        VALUES (${scope.accountId},${scope.userId},${scope.businessId},${conversationId},${randomUUID()},true,NULL,${AUTOMATIC_MODEL},${AUTOMATIC_MODEL},true)
        ON CONFLICT (account_id,user_id,business_id) DO NOTHING RETURNING id`
      return rows.length > 0
    }))
    if (made) created++
  }
  return created
})

/** The selection an automatic wake runs on: the working subscription now, or undefined for the hosted model. */
export const automaticSelection = (scope: Scope) => Effect.gen(function*() {
  return yield* resolveUnattendedSelection(scope, yield* lastChatSelection(scope))
})

/**
 * The model a follow-up wake runs on. A granted policy runs only on the model
 * it was granted for; an automatic one on the selection resolved for this wake.
 */
export const followupModel = (scope: Scope, wake: {
  readonly automatic: boolean; readonly selection: HarnessSelection | null; readonly provider: string; readonly model: string
}, selection: HarnessSelection | undefined) => Effect.gen(function*() {
  if (wake.automatic) return yield* (selection ? harnessModel(scope, selection) : configuredAgentModel)
  const picked = yield* (wake.selection ? harnessModel(scope, wake.selection) : configuredAgentModel)
  if (picked.provider !== wake.provider || picked.requestedModel !== wake.model) return yield* Effect.fail(new AgentModelError({ reason: "UNAVAILABLE" }))
  return picked
})
