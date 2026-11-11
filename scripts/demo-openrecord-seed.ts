// Demo business "OpenRecord": OpenRecord marketing itself (a DOGFOOD product),
// in the demo account, with sample data on every workspace page: approved
// facts, buyer questions with AI answers over two months, sources, a site
// inspection, a goal with 90 days of daily signups, initiatives, campaigns,
// inbox items, memory and chats.
//
// All of it is sample data. AI answers are marked synthetic, the goal import
// is a SYNTHETIC_FIXTURE, and nothing here is customer proof. The live provider
// sections (Search Console, ads, Google Business Profile, Stripe) and Channels
// come from apps/api/src/demo-data.ts once the business ID is listed in
// OPENRECORD_DEMO_BUSINESSES (the script prints the line for .env).
//
// Idempotent: the business, goal and initiatives replay by key, and the rest is
// written in one transaction only when the business has no facts yet.
// Run: DATABASE_URL=... pnpm --filter @openrecord/worker exec tsx ../../scripts/demo-openrecord-seed.ts
import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Redacted, Scope } from "effect"
import pg from "pg"
import { GrowthMeasurementRepository, GrowthMeasurementRepositoryLive, GrowthRepositoriesLive, GrowthRepository, RecordRepositoryLive, type Session } from "@openrecord/db"
import { PgClient } from "@effect/sql-pg"

const DEMO_EMAIL = "demo@northstar.test"
const NAME = "OpenRecord"
const SITE = "https://openrecord.example"
// Stable keys, so a replay returns the same registration and imports.
const REGISTER_KEY = "0b7c1e2a-5d3f-4c8e-9a61-2f4d8e7b1c01"
const DAY = 86_400_000

const url = process.env["DATABASE_URL"]
if (!url) {
  console.error("DATABASE_URL is required")
  process.exit(1)
}

const iso = (ms: number) => new Date(ms).toISOString()
const isoDay = (ago: number) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10)
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
/** Deterministic noise in [0, 1) from a string. */
const noise = (s: string) => parseInt(sha(s).slice(0, 8), 16) / 0x1_0000_0000

const FACTS: ReadonlyArray<[string, string, string]> = [
  ["monthly_price", "49 USD", "CURRENCY"], ["free_trial", "14 days", "TEXT"], ["setup_time", "under 1 hour", "TEXT"],
  ["integrations", "Google Analytics 4, Search Console, Google Ads, Meta Ads, Stripe, WordPress, GitHub", "TEXT"],
  ["assistants_checked", "ChatGPT, Claude, Gemini, Perplexity", "TEXT"], ["data_retention", "Raw answers kept for 13 months", "TEXT"],
  ["phone_support", "false", "BOOLEAN"], ["contact_email", "hello@openrecord.example", "TEXT"],
]

// Each question: what an assistant answers, and how often it is right.
const QUESTIONS: ReadonlyArray<{ prompt: string; right: string; wrong: string; accuracy: number }> = [
  { prompt: "How much does OpenRecord cost?", right: "OpenRecord costs 49 USD per month after a 14 day free trial.", wrong: "OpenRecord starts at 99 USD per month, billed annually.", accuracy: 0.55 },
  { prompt: "Which AI assistants does OpenRecord check?", right: "It checks answers from ChatGPT, Claude, Gemini and Perplexity.", wrong: "It only tracks Google AI Overviews.", accuracy: 0.8 },
  { prompt: "Does OpenRecord integrate with Google Analytics?", right: "Yes. It reads Google Analytics 4 and Search Console to tie AI visibility to signups.", wrong: "No analytics integrations are listed.", accuracy: 0.85 },
  { prompt: "What is the best tool to track how ChatGPT describes my company?", right: "OpenRecord asks assistants your buyers' questions and keeps their exact answers with sources.", wrong: "Most teams use a brand monitoring tool for social media.", accuracy: 0.35 },
  { prompt: "How long does OpenRecord take to set up?", right: "Setup takes under an hour: add your website and goal, and the agent drafts the rest.", wrong: "Setup usually takes a few weeks with an onboarding team.", accuracy: 0.6 },
  { prompt: "Is there a free trial of OpenRecord?", right: "Yes, 14 days, with no card required.", wrong: "There is no free trial; demos are by request.", accuracy: 0.7 },
  { prompt: "Can OpenRecord fix wrong answers AI gives about my business?", right: "It finds the sources assistants cite and prepares fixes for your approval.", wrong: "It can edit what assistants say directly.", accuracy: 0.65 },
  { prompt: "Does OpenRecord offer phone support?", right: "Support is by email and chat; there is no phone line.", wrong: "Phone support is available around the clock.", accuracy: 0.75 },
]
const PROVIDERS: ReadonlyArray<[string, string]> = [["gemini", "gemini-3.5-flash-lite"], ["9router", "openai/gpt-5.1"], ["9router", "anthropic/claude-sonnet-5-5"], ["9router", "perplexity/sonar-pro"]]

const main = async () => {
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as Record<string, unknown>
  const id = async (sql: string, params: unknown[] = []) => String((await one(sql, params))["id"])
  try {
    const user = await one(`SELECT u.id AS user_id, au.account_id FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.email = $1 LIMIT 1`, [DEMO_EMAIL])
    if (!user) throw new Error(`demo user not found: ${DEMO_EMAIL} (run db:seed:demo first)`)
    const session: Session = { userId: String(user["user_id"]), accountId: String(user["account_id"]) }

    // ---- The business, its goal and 90 days of signups (the real repositories) ----
    const repos = Layer.mergeAll(GrowthRepositoriesLive, GrowthMeasurementRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
    const scope = await Effect.runPromise(Scope.make())
    const ctx = await Effect.runPromise(Layer.buildWithScope(repos, scope)) as Context.Context<GrowthRepository | GrowthMeasurementRepository>
    const profile = await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      const growth = yield* GrowthRepository
      return yield* growth.registerProduct(session, {
        name: NAME, websiteUrl: SITE, engagement: "DOGFOOD",
        category: "Marketing software: AI search visibility",
        audience: "Marketing leads at B2B software companies and agencies who need to know what AI assistants say about them",
        valueProposition: "OpenRecord asks AI assistants your buyers' questions, keeps their exact answers and sources, and turns what is wrong or missing into fixes you approve.",
        goalStatement: "Grow trial signups from AI assistants and search",
        metric: { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "Product signups export",
          eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: null },
        idempotencyKey: REGISTER_KEY,
      })
    }), ctx as never))
    const businessId = profile.businessId
    const goalId = profile.primaryGoal.id
    const definitionId = profile.primaryGoal.metricDefinition.id
    const days: string[] = []
    for (let ago = 90; ago >= 1; ago--) days.push(isoDay(ago))
    const signups = (day: string, i: number) => {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
      return Math.max(0, Math.round(9 + i * 0.32 + 4 * Math.sin(i / 4.5) + (weekday === 0 || weekday === 6 ? -5 : 0) + noise(day) * 4))
    }
    const csv = `date,value\n${days.map((d, i) => `${d},${signups(d, i)}`).join("\n")}\n`
    await Effect.runPromise(Effect.provide(Effect.gen(function*() {
      return yield* (yield* GrowthMeasurementRepository).importDaily(session, businessId, definitionId, { provenance: "SYNTHETIC_FIXTURE", dateStart: days[0]!, dateEnd: days[days.length - 1]!, csv })
    }), ctx as never))

    // ---- Initiatives ----
    const initiatives = [
      { title: "Publish a pricing page assistants can quote", problemStatement: "Assistants guess OpenRecord's price in about half of their answers, usually too high.", proposedChange: "One public pricing page with the plan, trial and what is included, marked up with structured data.", targetUrl: `${SITE}/pricing`, initialStatus: "PROPOSED" as const },
      { title: "Get listed in AI visibility tool comparisons", problemStatement: "Answers to 'best tool to track how ChatGPT describes my company' cite comparison articles that do not mention OpenRecord.", proposedChange: "Pitch the five most-cited comparison articles with a short product summary and a demo account.", targetUrl: null, initialStatus: "DISCOVERED" as const },
      { title: "A setup guide that answers 'how long does it take'", problemStatement: "Two assistants say setup takes weeks with an onboarding team.", proposedChange: "A quickstart guide that shows setup in under an hour, linked from the homepage.", targetUrl: `${SITE}/docs/quickstart`, initialStatus: "PROPOSED" as const },
    ]
    for (const [i, x] of initiatives.entries()) {
      await Effect.runPromise(Effect.provide(Effect.gen(function*() {
        return yield* (yield* GrowthRepository).create(session, businessId, "OPERATOR", {
          goalId, title: x.title, problemStatement: x.problemStatement, audience: "Marketing leads evaluating AI visibility tools",
          buyerIntent: "Compare tools and prices before starting a trial", targetUrl: x.targetUrl, source: "AI answer checks",
          proposedChange: x.proposedChange, expectedMechanism: "Assistants quote pages that state the facts plainly, so answers stop guessing.",
          assumptions: "Assistants re-read the page within a few weeks.", uncertainty: "How quickly assistants pick up a new page varies from days to weeks.",
          baselineAvailability: "AVAILABLE", ownerUserId: session.userId, initialStatus: x.initialStatus,
          idempotencyKey: `0b7c1e2a-5d3f-4c8e-9a61-2f4d8e7b1c1${i}`, evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "From the last two months of AI answer checks." }],
        })
      }), ctx as never))
    }
    await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never))

    // Everything below is written once, in one transaction.
    if (await one(`SELECT 1 FROM authoritative_facts WHERE business_id = $1 LIMIT 1`, [businessId])) {
      console.log(`${NAME} already seeded: ${businessId}`)
      console.log(`OPENRECORD_DEMO_BUSINESSES=${businessId}`)
      return
    }
    await db.query("BEGIN")

    // ---- Facts and buyer questions ----
    const factIds: Record<string, string> = {}
    for (const [predicate, value, type] of FACTS) {
      factIds[predicate] = await id(`INSERT INTO authoritative_facts (business_id, subject, predicate, value_text, value_type, valid_from, source_kind)
        VALUES ($1,'openrecord',$2,$3,$4,'2026-08-01T00:00:00Z','MANUAL') RETURNING id`, [businessId, predicate, value, type])
    }
    const questionIds: string[] = []
    for (const q of QUESTIONS) questionIds.push(await id(`INSERT INTO buyer_questions (business_id, prompt, origin) VALUES ($1,$2,'SALES') RETURNING id`, [businessId, q.prompt]))

    // ---- AI answers: every question, four assistants, every third day for 60 days ----
    let claims = 0
    for (let ago = 60; ago >= 0; ago -= 3) {
      for (const [qi, q] of QUESTIONS.entries()) {
        for (const [pi, [provider, model]] of PROVIDERS.entries()) {
          const key = `${ago}-${qi}-${pi}`
          // Accuracy improves as the fixes land over the two months.
          const right = noise(key) < Math.min(0.95, q.accuracy + (60 - ago) / 200)
          const at = Date.now() - ago * DAY - (qi * 7 + pi) * 60_000 - 3 * 3_600_000
          const failed = noise(`fail-${key}`) < 0.03
          const run = await id(`INSERT INTO check_runs (business_id, question_id, provider, requested_model, status, queued_at, started_at, completed_at, failure_class, failure_detail_safe)
            VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9) RETURNING id`,
            [businessId, questionIds[qi], provider, model, failed ? "FAILED" : "SUCCEEDED", iso(at), iso(at + 38_000), failed ? "PROVIDER_TIMEOUT" : null, failed ? "provider timed out" : null])
          if (failed) continue
          const answer = right ? q.right : q.wrong
          const digest = `demo-openrecord-${key}`
          const raw = await id(`INSERT INTO raw_evidence (digest, content_text) VALUES ($1,$2) ON CONFLICT (digest) DO UPDATE SET digest = EXCLUDED.digest RETURNING id`, [digest, JSON.stringify({ answer })])
          const obs = await id(`INSERT INTO observations (business_id, check_run_id, provider, requested_model, observed_model, collected_at, answer_text, retrieval_mode, raw_evidence_id, raw_digest, synthetic)
            VALUES ($1,$2,$3,$4,$4,$5,$6,'WEB_SEARCH',$7,$8,true) RETURNING id`, [businessId, run, provider, model, iso(at + 38_000), answer, raw, digest])
          await db.query(`INSERT INTO observation_citations (observation_id, uri, title, position, attributed) VALUES ($1,$2,$3,1,$4)`,
            [obs, right ? `${SITE}/pricing` : "https://reviews.example/ai-visibility-tools", right ? "OpenRecord pricing" : "AI visibility tools compared", right])
          // The latest round becomes claims to judge; most are judged, a few wait for review.
          if (ago <= 3) {
            const claim = await id(`INSERT INTO candidate_claims (business_id, observation_id, text) VALUES ($1,$2,$3) RETURNING id`, [businessId, obs, answer])
            claims++
            if (noise(`judge-${key}`) < 0.8) {
              const judgment = await id(`INSERT INTO human_judgments (business_id, claim_id, verdict, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
                [businessId, claim, right ? "SUPPORTED" : noise(`p-${key}`) < 0.3 ? "PARTIAL" : "CONTRADICTED", right ? "Matches the approved facts." : "Does not match the approved facts."])
              await db.query(`INSERT INTO human_judgment_facts (judgment_id, fact_id) VALUES ($1,$2)`, [judgment, factIds["monthly_price"]])
            }
          }
        }
      }
    }

    // ---- Sources: the pages assistants read, and what they say ----
    const sources: ReadonlyArray<[string, "OWNED" | "THIRD_PARTY", string, string | null]> = [
      [`${SITE}/pricing`, "OWNED", "monthly_price", "49 USD"],
      [`${SITE}/docs/quickstart`, "OWNED", "setup_time", "under 1 hour"],
      ["https://reviews.example/ai-visibility-tools", "THIRD_PARTY", "monthly_price", "99 USD"],
      ["https://directory.example/openrecord", "THIRD_PARTY", "free_trial", "14 days"],
    ]
    for (const [i, [page, control, predicate, observed]] of sources.entries()) {
      const target = await id(`INSERT INTO source_targets (business_id, url, control) VALUES ($1,$2,$3) RETURNING id`, [businessId, page, control])
      const binding = await id(`INSERT INTO source_bindings (business_id, fact_id, source_target_id, extractor_kind, extractor_selector, comparator)
        VALUES ($1,$2,$3,'CSS_TEXT','.fact','EXACT_TEXT') RETURNING id`, [businessId, factIds[predicate], target])
      const so = await id(`INSERT INTO source_observations (business_id, source_target_id, collector, collector_version, requested_url, final_url, started_at, completed_at, http_status, content_type, body_digest, body_bytes, collection_state)
        VALUES ($1,$2,'NATIVE_HTTP','native-http/1',$3,$3, now() - interval '5 hours', now() - interval '5 hours' + interval '2 seconds', 200,'text/html',$4,5200,'FETCHED') RETURNING id`,
        [businessId, target, page, `demo-openrecord-source-${i}`])
      await db.query(`INSERT INTO observed_source_values (business_id, source_observation_id, source_binding_id, fact_id, extracted_value, extraction_state, evidence_selector, evidence_observation_id, evidence_node_identity)
        VALUES ($1,$2,$3,$4,$5,'OBSERVED','.fact',$2,'css:.fact')`, [businessId, so, binding, factIds[predicate], observed])
    }

    // ---- Website inspection: a few findings, one already fixed ----
    const site = await id(`INSERT INTO site_targets (business_id, root_url, canonical_origin) VALUES ($1,$2,$3) RETURNING id`, [businessId, `${SITE}/`, SITE])
    const inspection = await id(`INSERT INTO site_inspection_runs (business_id, site_target_id, state, queued_at, started_at, completed_at, urls_inspected, urls_failed, findings_produced, bytes_downloaded)
      VALUES ($1,$2,'SUCCEEDED', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day' + interval '3 minutes', 64, 1, 4, 3800000) RETURNING id`, [businessId, site])
    const findings: ReadonlyArray<[string, string, string, string, string, string]> = [
      [`${SITE}/pricing`, "MISSING_STRUCTURED_DATA", "HIGH", "SEARCH_PRESENTATION", "OPEN", "Add Product and Offer structured data so the price is machine readable."],
      [`${SITE}/blog/how-assistants-pick-sources`, "MISSING_META_DESCRIPTION", "MEDIUM", "SEARCH_PRESENTATION", "OPEN", "Write a meta description that states what the article answers."],
      [`${SITE}/old-pricing`, "NOT_FOUND", "MEDIUM", "CRAWL_INDEX_RISK", "OPEN", "Redirect the old pricing URL to /pricing."],
      [`${SITE}/docs/quickstart`, "MISSING_TITLE", "LOW", "SEARCH_PRESENTATION", "VERIFIED_FIXED", "Fixed: the page now has a descriptive title."],
    ]
    const kinds = new Set((await db.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'site_findings'::regclass AND contype = 'c'`)).rows.map(r => String(r["d"])).join(" ").match(/'[A-Z_]+'/g)?.map(s => s.slice(1, -1)) ?? [])
    for (const [page, kind, severity, category, status, action] of findings) {
      if (!kinds.has(kind)) continue
      await db.query(`INSERT INTO site_findings (business_id, site_target_id, run_id, url, canonical_url, finding_kind, severity, category, status, recommended_action, confidence, identity_key, evidence)
        VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,'HIGH',$10,'{}'::jsonb)`, [businessId, site, inspection, page, kind, severity, category, status, action, sha(`${page}:${kind}`)])
    }

    // ---- Inbox: checks the agent proposes ----
    for (const [qi, message] of [[0, "Re-check the price question now that the pricing page is live."], [4, "Re-check the setup question after the quickstart guide went up."]] as const) {
      await db.query(`INSERT INTO agent_proposals (business_id, kind, question_id, message, proposer, proposed_by_user_id) VALUES ($1,'REQUEST_CHECK',$2,$3,'assistant-v1',$4)`,
        [businessId, questionIds[qi], message, session.userId])
    }

    // ---- Campaigns ----
    const task = (title: string, status: "TODO" | "IN_PROGRESS" | "DONE", due: number, channel: "WEBSITE" | "EMAIL" | "PAID" | "SOCIAL" | "OTHER" = "WEBSITE") =>
      ({ id: randomUUID(), title, owner: "Growth team", due: isoDay(due), channel, status, note: "" })
    const empty = { result: "", decision: "UNDECIDED", learning: "", nextMove: "" }
    const campaigns = [
      { title: "Pricing clarity for AI answers", goal: "Stop assistants guessing our price", audience: "Marketing leads comparing AI visibility tools", offer: "14 day free trial",
        message: "One plan, 49 USD a month, everything included.", hypothesis: "A plain pricing page makes assistants quote the right price within four weeks.",
        metric: "Share of price answers that match the approved fact", baseline: "55%", target: "85%", owner: "Growth team", launchDate: isoDay(24), reviewDate: isoDay(-4), status: "ACTIVE",
        tasks: [task("Publish the pricing page", "DONE", 26), task("Add Offer structured data", "DONE", 22), task("Ask four assistants again", "DONE", 3)], ...empty },
      { title: "Comparison article outreach", goal: "Appear in the articles assistants cite for 'best AI visibility tool'", audience: "Editors of software comparison sites", offer: "A demo account and a one-page summary",
        message: "The only tool that keeps the exact answer and its sources.", hypothesis: "Two placements in the five most-cited articles lift recommendations.",
        metric: "Recommendations in category answers", baseline: "1 in 12", target: "4 in 12", owner: "Founder", launchDate: isoDay(-7), reviewDate: isoDay(-35), status: "DRAFT",
        tasks: [task("List the five most-cited articles", "DONE", 2), task("Write the pitch", "IN_PROGRESS", -3, "EMAIL"), task("Send to editors", "TODO", -7, "EMAIL")], ...empty },
      { title: "Search ads on 'AI answer monitoring'", goal: "Trial signups from high-intent searches", audience: "People searching for AI answer monitoring", offer: "14 day free trial",
        message: "See what ChatGPT says about you, today.", hypothesis: "Exact-match ads convert above 3%.", metric: "Trial signups from search ads", baseline: "0", target: "40 a month",
        owner: "Growth team", launchDate: isoDay(70), reviewDate: isoDay(40), status: "CLOSED", tasks: [task("Launch exact-match campaign", "DONE", 70, "PAID")],
        result: "52 signups in 30 days at 31 USD each.", decision: "KEEP", learning: "Exact match beats broad match on cost per signup by half.", nextMove: "Add a comparison-intent ad group." },
    ]
    for (const brief of campaigns) {
      const cid = randomUUID()
      await db.query(`INSERT INTO marketing_campaigns (id, business_id, created_by_user_id, brief, objective_goal_id, created_by_actor) VALUES ($1,$2,$3,$4::jsonb,$5,'OPERATOR')`,
        [cid, businessId, session.userId, JSON.stringify(brief), goalId])
      await db.query(`INSERT INTO marketing_campaign_revisions (campaign_id, revision, actor_user_id, brief) VALUES ($1,1,$2,$3::jsonb)`, [cid, session.userId, JSON.stringify(brief)])
    }

    // ---- Memory ----
    for (const [kind, text] of [["PREFERENCE", "Write for marketing leads, in plain English."], ["DECISION", "Pricing page work comes before comparison outreach."], ["LESSON", "Exact-match search ads convert at half the cost of broad match."]] as const) {
      await db.query(`INSERT INTO business_memories (account_id, business_id, kind, text, text_digest, source, created_by_user_id) VALUES ($1,$2,$3,$4,$5,'OPERATOR',$6)`,
        [session.accountId, businessId, kind, text, sha(text), session.userId])
    }

    // ---- Chats ----
    const chat = async (title: string, hoursAgo: number, turns: ReadonlyArray<[string, string, ReadonlyArray<[string, string]>]>) => {
      const messages = turns.flatMap(([ask, reply, tools]) => [
        { role: "user", text: ask },
        { role: "agent", text: reply, toolCalls: tools.map(([tool, summary]) => ({ tool, summary })), citations: [],
          activity: [{ kind: "thought", text: "Start from the goal and the latest answers, then what changed since last week.", ms: 4200 }, ...tools.map(([tool, text]) => ({ kind: "tool", tool, text }))],
          durationMs: 18_000, inference: { provider: "anthropic", requestedModel: "claude-sonnet-5-5" } },
      ])
      // Only the newest chat is the current one; earlier chats are kept in history.
      await db.query(`INSERT INTO agent_conversations (account_id, business_id, user_id, messages, revision, last_reply, created_at, updated_at, expires_at, archived_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb, now() - ($7 || ' hours')::interval, now() - ($7 || ' hours')::interval, now() + interval '30 days',
          CASE WHEN $8 THEN NULL ELSE now() - ($7 || ' hours')::interval END)`,
        [session.accountId, businessId, session.userId, JSON.stringify(messages), messages.length, JSON.stringify({ title }), String(hoursAgo), hoursAgo === 2])
    }
    await chat("Weekly growth brief", 2, [["What changed this week?",
      "Trial signups are up **18%** on the week before, 96 against 81.\n\n- Assistants now quote the right price in 7 of 8 checks, up from 4 of 8 a month ago.\n- Search clicks rose 24%, mostly on \"ai answer monitoring\".\n- One comparison article still lists the old 99 USD price.\n\nNext step: ask that article's editor to correct the price. I drafted the note in your inbox.",
      [["read_growth_goal", "Trial signups: 96 in the last 7 days"], ["read_results", "Price answers correct in 7 of 8 checks"], ["read_search_performance", "Clicks up 24% over 28 days"]]]])
    await chat("Why does ChatGPT say we cost 99 USD?", 26, [["Why does ChatGPT say we cost 99 USD?",
      "It quotes a comparison article that lists the old annual plan at 99 USD. Your own pricing page says 49 USD a month, and Claude and Gemini already quote that.\n\nThe fix is a correction request to the article. I can prepare it for your approval.",
      [["read_open_issues", "1 wrong price in current answers"], ["read_web_page", "reviews.example lists 99 USD"]]]])
    await chat("Plan the comparison outreach", 74, [["Plan outreach to the comparison articles",
      "The five articles assistants cite most for \"best AI visibility tool\" are ranked by how often they appear. I saved a draft campaign with the pitch, the owner and the dates for your review.",
      [["read_research_evidence", "5 most-cited comparison pages"], ["record_campaign_draft", "Saved draft: Comparison article outreach"]]]])
    await chat("Set up the signup goal", 140, [["Help me set the main goal", "Done. The goal is trial signups, read daily from your product's export. The last 90 days are in, so the Overview can show the trend.", [["read_growth_goal", "Goal: Grow trial signups"]]]])

    await db.query("COMMIT")
    console.log(`seeded ${NAME}: ${businessId} (${claims} claims, ${days.length} days of signups)`)
    console.log(`Add to .env so the live sections and Channels show sample data:\nOPENRECORD_DEMO_BUSINESSES=${businessId}`)
  } catch (e) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw e
  } finally {
    await db.end()
  }
}

main().then(() => process.exit(0), e => {
  console.error(e)
  process.exit(1)
})
