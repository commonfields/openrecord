// What to measure in AI answers, suggested for the person to confirm: setup's
// competitors at first, an accepted buyer-question proposal's once there is
// one, and the frozen set's as confirmed. The agent reads it as unconfirmed.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AgentProposalRepository, AgentProposalRepositoryLive, sealDraft } from "@openrecord/db"
import { acquisitionSuggestion } from "./acquisition-suggestion.js"
import { readCompetitors } from "./agent-ads-tools.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("AI-answer measurement suggestion (disposable PostgreSQL)", () => {
  const runtime = ManagedRuntime.make(AgentProposalRepositoryLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))))
  let pool: pg.Pool
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await runtime.dispose(); await pool.end() })

  it("suggests setup's competitors, then an accepted proposal's, and the agent calls them unconfirmed", async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST suggestion') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`sug-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'Northstar Dental') RETURNING id", [accountId])).rows[0].id)
    const draft = { businessName: "Northstar Dental", category: "Family dentistry", audience: "Families", valueProposition: "Gentle care", goalStatement: "More bookings",
      conversionKind: "BOOKING", metricLabel: "Bookings", competitors: [{ name: "Bright Smiles", website: "https://www.brightsmiles.test" }, { name: "Downtown Dental" }] }
    await pool.query(`INSERT INTO business_setups(account_id,business_id,website_url,website_host,started_by_user_id,draft,draft_status) VALUES($1,$2,'https://www.northstar.test','northstar.test',$3,$4::jsonb,'READY')`,
      [accountId, businessId, userId, JSON.stringify(draft)])

    const first = await runtime.runPromise(acquisitionSuggestion(accountId, businessId))
    expect(first).toMatchObject({ source: "SETUP", brandName: "Northstar Dental", category: "Family dentistry", domains: ["northstar.test"], questions: [], confirmedCompetitors: [], hasFrozenSet: false })
    expect(first.competitors.map(c => c.name)).toEqual(["Bright Smiles", "Downtown Dental"])
    const tool = await runtime.runPromise(readCompetitors(accountId, businessId))
    expect(tool.summary).toBe("2 suggested competitors, not confirmed yet")
    expect(tool.data).toMatchObject({ suggestedFrom: "the agent's reading of the website during setup", confirmed: [] })

    // A saved buyer-question proposal with its own competitors takes over.
    await runtime.runPromise(Effect.flatMap(AgentProposalRepository, r => r.propose({ accountId, businessId, kind: "PROPOSE_QUESTION_SET", questionId: null, message: "Review", proposer: "assistant-v1", proposedByUserId: userId,
      payload: sealDraft({ kind: "PROPOSE_QUESTION_SET", businessId, generatedAt: new Date().toISOString(), text: "Proposed buyer questions", references: [],
        evidence: { category: "Pediatric dentistry", questions: [{ group: "CATEGORY_DISCOVERY", prompt: "Best kids dentist in Austin?" }], competitors: [{ name: "Tiny Teeth" }] } }) })))
    const second = await runtime.runPromise(acquisitionSuggestion(accountId, businessId))
    expect(second).toMatchObject({ source: "PROPOSAL", category: "Pediatric dentistry", competitors: [{ name: "Tiny Teeth" }], questions: [{ group: "CATEGORY_DISCOVERY", prompt: "Best kids dentist in Austin?" }] })
  })
})
