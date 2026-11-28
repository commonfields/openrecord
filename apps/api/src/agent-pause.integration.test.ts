// A turn that pauses for the owner's decision, against a disposable PostgreSQL
// with a scripted model: the pause is kept with its reply; deciding the card
// continues the same model conversation with the decision as the answer, once;
// a pause waiting on two cards waits for both; one the chat moved past falls
// back to the ordinary resume from the chat's text.
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { runConversation } from "./agent.js"
import type { ModelInput, ModelResponse } from "./agent-model.js"
import { sendConversation, type Responder } from "./agent-conversations.js"
import { writeDecisionResumeJob, type DecisionResumePayload } from "./decision-resume.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const reply = (parts: Array<Record<string, unknown>>): ModelResponse => ({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] })
const call = (name: string, args: Record<string, unknown>) => ({ functionCall: { name, args } })

suite("pausing a turn for the owner's decision (disposable PostgreSQL, scripted model)", () => {
  const pool = new pg.Pool({ connectionString: url })
  const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url) }))
  const run = <A, E>(fx: Effect.Effect<A, E, any>) => runtime.runPromise(fx as Effect.Effect<A, E, never>)
  afterAll(async () => { await runtime.dispose(); await pool.end() })

  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST pause') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`pause-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST pause') RETURNING id", [accountId])).rows[0].id)
    return { accountId, userId, businessId }
  }
  /** The real conversation loop with a scripted model; propose_check_run saves the next scripted card ID. */
  const scripted = (script: ModelResponse[], seen: ModelInput[], cards: string[]): Responder<never> =>
    (_a, _u, _b, message, history, _sel, _active, journal, turn) => runConversation({ message, history, journal,
      model: req => { seen.push(req); return Effect.succeed(script.shift() ?? text("done")) },
      tools: [{ name: "propose_check_run", description: "TEST propose", parametersJsonSchema: { type: "object" } }],
      dispatch: () => Effect.succeed({ summary: "Re-check proposed", citations: [], data: { proposalId: cards.shift()!, status: "PROPOSED", executed: false } }),
      pausable: turn.pausable, resumeContents: turn.resume,
    }).pipe(Effect.map(a => ({ ...a, provider: "test", requestedModel: "test" }))) as never
  const feedback = (f: { accountId: string; businessId: string; userId: string }, itemId: string, verdict: string) =>
    pool.query("INSERT INTO decision_feedback(account_id,business_id,kind,item_id,verdict,title,reason,decided_by_user_id) VALUES($1,$2,'AGENT_PROPOSAL',$3,$4,'TEST re-check','TEST reason',$5)",
      [f.accountId, f.businessId, itemId, verdict, f.userId])
  const payload = (scope: { accountId: string; userId: string; businessId: string }, conversationId: string, itemId: string): DecisionResumePayload =>
    ({ scope, conversationId, kind: "AGENT_PROPOSAL", itemId, message: "OpenRecord notice: the owner decided." })

  it("keeps the paused conversation with its reply and continues it, once, after the decision", async () => {
    const f = await fixture(), scope = f
    const card = randomUUID(), seen: ModelInput[] = []
    const script = [
      reply([call("propose_check_run", { questionId: randomUUID() })]),
      reply([{ text: "I saved a re-check. I'll measure once you approve it." }, call("wait_for_decision", { itemIds: [card] })]),
      // The continued turn.
      text("Approved, so I measured it."),
    ]
    const responder = scripted(script, seen, [card])
    const first: any = await run(sendConversation(scope, { message: "Fix the pricing answer", requestId: randomUUID(), revision: 0 }, responder))
    expect(first.reply).toBe("I saved a re-check. I'll measure once you approve it.")
    expect(first.waiting).toEqual({ itemIds: [card] })
    expect(first.pause).toBeUndefined()
    const conversationId = String(first.conversationId)
    const pause = (await pool.query("SELECT item_ids, resumed_at, checkpoint FROM agent_turn_pauses WHERE conversation_id=$1", [conversationId])).rows[0]
    expect(pause.item_ids).toEqual([card])
    expect(pause.resumed_at).toBeNull()
    expect(pause.checkpoint.contents[0].parts.at(-1).text).toBe("Fix the pricing answer")
    const saved = (await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [conversationId])).rows[0].messages
    expect(saved.at(-1)).toMatchObject({ role: "agent", waiting: { itemIds: [card] }, decisions: [{ type: "AGENT_PROPOSAL", id: card }] })
    expect(seen[1]!.tools.some((t: any) => t.name === "wait_for_decision")).toBe(true)

    // Undecided: nothing runs.
    const sender = (s: any, body: any) => sendConversation(s, body, responder)
    await run(writeDecisionResumeJob(payload(scope, conversationId, card), sender, { finalAttempt: false }))
    expect(seen).toHaveLength(2)
    // Decided: the same conversation continues, with the decision as the answer to wait_for_decision.
    await feedback(f, card, "APPROVED")
    await run(writeDecisionResumeJob(payload(scope, conversationId, card), sender, { finalAttempt: false }))
    expect(seen).toHaveLength(3)
    const resumed = seen[2]!.contents
    expect(resumed.slice(0, pause.checkpoint.contents.length)).toEqual(pause.checkpoint.contents)
    const answer = (resumed.at(-1)!.parts.at(-1) as any).functionResponse
    expect(answer.name).toBe("wait_for_decision")
    expect(answer.response.decisions).toEqual([{ itemId: card, kind: "AGENT_PROPOSAL", verdict: "APPROVED", title: "TEST re-check", reason: "TEST reason" }])
    const after = (await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [conversationId])).rows[0].messages
    expect(after.slice(-2)).toMatchObject([{ role: "user", origin: { kind: "wake", title: "Continuing after your decision" } }, { role: "agent", text: "Approved, so I measured it." }])
    expect((await pool.query("SELECT resumed_at IS NOT NULL AS used FROM agent_turn_pauses WHERE conversation_id=$1", [conversationId])).rows[0].used).toBe(true)
    // Used once: another job for the same card starts nothing.
    await run(writeDecisionResumeJob(payload(scope, conversationId, card), sender, { finalAttempt: false }))
    expect(seen).toHaveLength(3)
  })

  it("waits for every card it paused on, refuses cards it did not save, and falls back once the chat moved on", async () => {
    const f = await fixture(), scope = f
    const one = randomUUID(), two = randomUUID(), seen: ModelInput[] = []
    const script = [
      reply([call("propose_check_run", {}), call("propose_check_run", {})]),
      // A card from elsewhere is refused; the model then waits on its own two.
      reply([call("wait_for_decision", { itemIds: [randomUUID()] })]),
      reply([{ text: "Waiting on both." }, call("wait_for_decision", { itemIds: [one, two] })]),
    ]
    const responder = scripted(script, seen, [one, two])
    const first: any = await run(sendConversation(scope, { message: "Prepare two re-checks", requestId: randomUUID(), revision: 0 }, responder))
    expect(first.waiting).toEqual({ itemIds: [one, two] })
    // The model's requests share the loop's growing conversation: look through all of it.
    const refused = seen[2]!.contents.flatMap(c => c.parts as any[]).find(p => p.functionResponse?.name === "wait_for_decision")?.functionResponse
    expect(refused).toMatchObject({ name: "wait_for_decision", response: { error: "INVALID_INPUT" } })
    const conversationId = String(first.conversationId)
    const sender = (s: any, body: any) => sendConversation(s, body, responder)
    await feedback(f, one, "APPROVED")
    await run(writeDecisionResumeJob(payload(scope, conversationId, one), sender, { finalAttempt: false }))
    expect(seen).toHaveLength(3)
    // The person writes in the chat before deciding the second: the pause is passed by, and the resume uses the chat's text.
    script.push(text("Here is the summary."), text("Declined, noted."))
    await run(sendConversation(scope, { message: "Summarise first", requestId: randomUUID(), conversationId, revision: first.revision }, responder))
    await feedback(f, two, "REJECTED")
    await run(writeDecisionResumeJob(payload(scope, conversationId, two), sender, { finalAttempt: false }))
    expect(seen).toHaveLength(5)
    expect(JSON.stringify(seen[4]!.contents)).not.toContain("wait_for_decision")
    const messages = (await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [conversationId])).rows[0].messages
    expect(messages.at(-2)).toMatchObject({ origin: { kind: "wake", title: "After your decision" } })
    expect((await pool.query("SELECT resumed_at FROM agent_turn_pauses WHERE conversation_id=$1", [conversationId])).rows[0].resumed_at).toBeNull()
  })
})
