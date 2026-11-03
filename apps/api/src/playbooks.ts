// Playbooks: reusable requests for the agent, offered as /name in the
// composer. OpenRecord ships marketing playbooks for SEO, answer-engine (AEO)
// and generative-engine (GEO) work; an account adds its own, shared across its
// businesses. Choosing a playbook types its prompt into the composer: nothing
// runs until a person sends it, and the agent's own rules (proposals need
// approval, unknown stays unknown) apply as for any message.
//
//   GET    /api/playbooks          built-in and the account's own
//   PUT    /api/playbooks/:name    save (create or replace) one of the account's own
//   DELETE /api/playbooks/:name    delete one of the account's own
import { SqlClient } from "@effect/sql"
import { HttpRouter, type HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import type { Session } from "@openrecord/db"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

export interface Playbook { readonly name: string; readonly title: string; readonly prompt: string; readonly area: string; readonly builtIn: boolean }

/** Names the composer already uses for its own commands. */
const RESERVED = new Set(["setup", "status", "plan", "report"])

export const BUILT_IN_PLAYBOOKS: ReadonlyArray<Playbook> = [
  { name: "seo-audit", area: "SEO", title: "Search audit and the first fix", builtIn: true,
    prompt: "Audit {business}'s website for search: run the site audit, read Search Console and Bing Webmaster data if connected, and check indexing, titles, canonicals, structured data and speed. List the five fixes with the most impact, each with the pages affected and how we'll confirm it worked, then prepare the first one for my approval." },
  { name: "keyword-gaps", area: "SEO", title: "Keywords competitors win and we don't", builtIn: true,
    prompt: "Find the search phrases buyers use for what {business} sells that our closest competitors rank for and we don't (ranked keywords, keyword ideas and search results). Group them by intent, say which existing page should target each group or whether we need a new page, and draft a brief for the most valuable one." },
  { name: "aeo-check", area: "AEO", title: "What AI assistants answer about us", builtIn: true,
    prompt: "Check how AI assistants answer our buyers' questions about {business}: ask our tracked questions on the connected AI models, then report visibility, our position, which competitors are named instead, and fact-check every answer against our approved facts. Name the wrong or missing answers first, with the page each answer cited and the change on a page we control that would correct it." },
  { name: "ai-crawlers", area: "AEO", title: "Can AI crawlers read our site?", builtIn: true,
    prompt: "Check whether AI crawlers and assistants can read {business}'s website: robots.txt rules per crawler, whether the firewall refuses them, llms.txt, server-rendered content and structured data on our key pages, and live AI crawler and referral traffic if a feed or log is connected. List what blocks them and propose the fixes." },
  { name: "geo-citations", area: "GEO", title: "Get onto the sources AI cites", builtIn: true,
    prompt: "Find which sources AI answers cite when buyers ask about our category: the most-cited domains and pages, which of them name our competitors but not {business}, and what kind of source each is (review site, comparison, forum, directory, publisher). Give a plan to earn a mention on the five that matter most, with the exact page and the angle for each. Keep them as citation targets (geo.citation_targets) so we can track pitched and listed, and verify listings later (geo.verify_targets)." },
  { name: "schema-kit", area: "AEO", title: "Structured data and llms.txt from our facts", builtIn: true,
    prompt: "Build structured data (JSON-LD) and an llms.txt for {business} from our approved facts only (aeo.schema_kit), tell me which facts it couldn't map, and prepare the change to our home and pricing pages for my approval." },
  { name: "rank-watch", area: "SEO", title: "Track our rankings for key searches", builtIn: true,
    prompt: "Check where {business} ranks today for our five most important buyer searches (seo.serp), show how each moved since the earlier checks (seo.rank_history), and set a weekly follow-up to keep the history going." },
  { name: "entity-consistency", area: "GEO", title: "Are our facts consistent across the web?", builtIn: true,
    prompt: "Check that the facts AI models learn about {business} are consistent wherever they're published: our website, Google Business Profile, directories, Wikipedia and Wikidata, social profiles and the pages AI answers cite. List every place a price, address, hours, feature or claim differs from our approved facts, and which to fix first." },
  { name: "competitor-scan", area: "Research", title: "How our top competitors win customers", builtIn: true,
    prompt: "Research {business}'s three closest competitors: positioning, pricing, content cadence, ads they run, the channels and search phrases that bring them customers, and how AI assistants describe them compared with us. Finish with the two moves we should copy and the one gap we can take." },
  { name: "daily-loop", area: "Loop", title: "Daily marketing-site loop", builtIn: true,
    prompt: "Daily marketing loop for {business}. Focus: the whole site (change this line to a page, feature or competitor to focus on).\n\nRead what is new since the last run: Search Console queries and pages (favour high impressions with low click-through, and rising searches), site analytics, the latest site audit, AI answer checks and competitors' recent page changes. Check read_decision_feedback first and don't repeat anything I rejected. Propose one to three changes to the marketing site (a new section, an FAQ, a feature callout, a comparison block, a fix where a page lags the product), each with a one-line rationale and the evidence behind it, and save them for my approval. If nothing new justifies a change, say so and propose nothing." },
  { name: "paying-users", area: "Loop", title: "What drives paying customers", builtIn: true,
    prompt: "Find what drives paying customers for {business}: revenue and new customers from Stripe (if connected), which landing pages and referrers they came through, and the searches behind those pages. Separate what correlates with paying customers from what only brings traffic, without claiming causes. Then propose homepage or landing-page changes that put what converts up front, for my approval, and say which connection would sharpen this." },
  { name: "outcome-review", area: "Review", title: "What happened after approved work", builtIn: true,
    prompt: "Review {business}'s approved work that is due an outcome note (read_decision_feedback): for each, compare search performance, AI answers, traffic and revenue before and after the decision date, record a short outcome note with dates and sources and competing explanations, and tell me which kinds of change look worth doing more of. Never claim the work caused a change." },
  { name: "portfolio-digest", area: "Review", title: "Rank this week's opportunities", builtIn: true,
    prompt: "Weekly digest for {business}: list the open opportunities and pending decisions, rank them by likely impact against the effort my approval takes, and keep it to the five worth my time this week. Say which to drop." },
  { name: "weekly-review", area: "Review", title: "Weekly marketing review", builtIn: true,
    prompt: "Weekly review for {business}: what changed this week in search, AI answers, AI traffic, ads, revenue and our channels; what we shipped and what we can verify it did, without claiming causes the evidence doesn't show; what is waiting for my decision; and the three most useful actions for next week." },
]

const NAME = /^[a-z][a-z0-9-]{1,39}$/
const Save = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
})

const ownOf = (accountId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT name, title, prompt FROM agent_playbooks WHERE account_id = ${accountId} ORDER BY name`
  return rows.map((r): Playbook => ({ name: String(r["name"]), title: String(r["title"]), prompt: String(r["prompt"]), area: "Saved", builtIn: false }))
})

export const playbooksApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const route = <E, R>(run: (session: Session, name: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      return yield* run(session, params["name"] ?? "")
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "PlaybooksUnavailable" })))
  const list = (accountId: string) => Effect.map(ownOf(accountId), own => ({ playbooks: [...BUILT_IN_PLAYBOOKS, ...own] }))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/playbooks", route(s => Effect.flatMap(list(s.accountId), body => json(200, body, { "cache-control": "no-store" })))),
    HttpRouter.put("/api/playbooks/:name", route((s, name) => Effect.gen(function*() {
      if (!NAME.test(name)) return yield* json(422, { _tag: "InvalidName", rule: "2 to 40 characters: lowercase letters, digits and hyphens, starting with a letter" })
      if (RESERVED.has(name) || BUILT_IN_PLAYBOOKS.some(p => p.name === name)) return yield* json(409, { _tag: "NameTaken" })
      const body = decode(Save, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO agent_playbooks(account_id, name, title, prompt, created_by_user_id) VALUES (${s.accountId}, ${name}, ${body.title.trim()}, ${body.prompt.trim()}, ${s.userId})
        ON CONFLICT (account_id, name) DO UPDATE SET title = EXCLUDED.title, prompt = EXCLUDED.prompt, updated_at = now()`
      return yield* json(200, yield* list(s.accountId))
    }))),
    HttpRouter.del("/api/playbooks/:name", route((s, name) => Effect.gen(function*() {
      if (!NAME.test(name)) return yield* json(422, { _tag: "InvalidName" })
      const sql = yield* SqlClient.SqlClient
      const gone = yield* sql`DELETE FROM agent_playbooks WHERE account_id = ${s.accountId} AND name = ${name} RETURNING name`
      return yield* json(gone.length ? 200 : 404, gone.length ? yield* list(s.accountId) : { _tag: "PlaybookNotFound" })
    }))),
  )
}
