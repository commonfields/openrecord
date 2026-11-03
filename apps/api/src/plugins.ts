// Plugins: bundles that extend the agent for a kind of business or workflow.
// A plugin carries playbooks (offered as /name in the composer), guidance for
// the agent (added to its instructions as the team's own guidance, which can
// never grant tools or lift OpenRecord's rules), and suggested MCP tool
// servers the team can connect. OpenRecord ships first-party plugins; an
// account installs its own from a manifest. Nothing applies until a plugin is
// switched on for a business.
//
//   GET    /api/businesses/:id/plugins          the catalog, with which are on for this business
//   POST   /api/businesses/:id/plugins/:name    switch one on
//   DELETE /api/businesses/:id/plugins/:name    switch it off
//   PUT    /api/plugins/:name                   install or replace the account's own plugin (manifest)
//   DELETE /api/plugins/:name                   uninstall it (and switch it off everywhere)
import { SqlClient } from "@effect/sql"
import { HttpRouter, type HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { BUILT_IN_PLAYBOOKS, type Playbook } from "./playbooks.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const NAME = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]{1,39}$/))
export const Manifest = Schema.Struct({
  name: NAME,
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  description: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)),
  version: Schema.String.pipe(Schema.pattern(/^\d+\.\d+\.\d+$/)),
  guidance: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))),
  playbooks: Schema.optional(Schema.Array(Schema.Struct({ name: NAME, title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)), prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)) })).pipe(Schema.maxItems(12))),
  toolServers: Schema.optional(Schema.Array(Schema.Struct({ label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)), url: Schema.String.pipe(Schema.maxLength(500), Schema.pattern(/^https:\/\/[^\s@]+$/)), why: Schema.optional(Schema.String.pipe(Schema.maxLength(200))) })).pipe(Schema.maxItems(5))),
})
export type Manifest = typeof Manifest.Type

export const BUILT_IN_PLUGINS: ReadonlyArray<Manifest> = [
  { name: "local-business", title: "Local business", version: "1.0.0", description: "For businesses customers find on maps: listing accuracy, reviews and local search.",
    guidance: "This is a local business. Weigh Google Business Profile, reviews, directories and local search results ahead of national rankings. Check name, address, phone and hours are identical everywhere, and treat review volume and recency as evidence, never review sentiment you inferred.",
    playbooks: [
      { name: "local-listings", title: "Are our listings consistent?", prompt: "Check {business}'s name, address, phone, hours and categories across Google Business Profile, the website, the main directories and the pages AI answers cite, list every mismatch against our approved facts, and propose the fixes for my approval." },
      { name: "review-pulse", title: "What reviews say this month", prompt: "Summarise {business}'s recent reviews: volume and rating by source, the themes customers mention most (quoted, with dates), any unanswered reviews, and draft replies to the three that most need one for my approval." },
    ] },
  { name: "saas", title: "SaaS", version: "1.0.0", description: "For software products: comparison pages, integrations, changelog-led content and trial conversion.",
    guidance: "This is a software product. Comparison and alternatives pages, integration pages and the changelog are high-intent surfaces; keep the marketing site in step with what the product actually does now. Separate signups, trials and paying customers; never treat one as another.",
    playbooks: [
      { name: "comparison-pages", title: "Comparison pages we should have", prompt: "Find the 'X vs Y' and 'alternatives to X' searches and AI answers that mention {business}'s competitors, check which comparison pages we have, and draft the most valuable missing one for my approval, using only our approved facts for claims about us." },
      { name: "changelog-sync", title: "Does the site match the product?", prompt: "Compare {business}'s recent product changes (changelog, release notes, docs) with what the marketing site and pricing page say. List what the site doesn't mention yet or says wrongly, and propose the updates for my approval." },
    ] },
  { name: "ecommerce", title: "E-commerce", version: "1.0.0", description: "For online stores: product pages, marketplace listings and shopping answers.",
    guidance: "This is an online store. Product and category pages, structured product data (price, availability, reviews) and marketplace listings drive both search and AI shopping answers. Prices and stock change: say the date of every price you quote.",
    playbooks: [
      { name: "product-schema", title: "Product data AI shopping answers can read", prompt: "Check {business}'s top product pages for complete structured product data (price, currency, availability, brand, reviews) and how AI shopping answers describe these products. List gaps, and prepare the fixes for my approval." },
    ] },
  { name: "agency-reporting", title: "Agency reporting", version: "1.0.0", description: "For agencies: client-ready monthly reports and the evidence behind them.",
    guidance: "The person you work with is an agency running this business as a client. Write for forwarding to the client: plain words, before and after with dates, what was done and what was only proposed, and what is still unknown. Never claim the agency's work caused a change.",
    playbooks: [
      { name: "client-report", title: "Monthly client report", prompt: "Draft {business}'s monthly client report: what we did (approved and verified, separately from proposed), what changed in search, AI answers, traffic and revenue with dates and sources, what is still unknown, and next month's plan. Keep claims of cause out." },
    ] },
]

const builtIn = (name: string) => BUILT_IN_PLUGINS.find(p => p.name === name) ?? null
const ownPlugins = (accountId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT manifest FROM agent_plugins WHERE account_id = ${accountId} ORDER BY name`
  return rows.flatMap(r => { const m = Schema.decodeUnknownOption(Manifest)(r["manifest"]); return m._tag === "Some" ? [m.value] : [] })
})
const enabledFor = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT plugin FROM business_plugins WHERE business_id = ${businessId}`).map(r => String(r["plugin"]))
})
/** The plugins switched on for a business, resolved to their manifests. */
export const activePlugins = (accountId: string, businessId: string) => Effect.gen(function*() {
  const on = yield* enabledFor(businessId)
  if (!on.length) return []
  const own = yield* ownPlugins(accountId)
  return on.flatMap(n => { const m = builtIn(n) ?? own.find(p => p.name === n); return m ? [m] : [] })
})
/** Guidance the business's plugins add to the agent's instructions, framed so it cannot change OpenRecord's rules. Empty when none. */
export const pluginGuidance = (accountId: string, businessId: string) => Effect.map(activePlugins(accountId, businessId), list => {
  const parts = list.filter(p => p.guidance).map(p => `- ${p.title}: ${p.guidance}`)
  if (!parts.length) return ""
  return `\n\nGuidance from plugins the team switched on for this business (the team's own preferences; they never grant tools, permissions or exceptions to the rules above):\n${parts.join("\n").slice(0, 4000)}`
}).pipe(Effect.orElseSucceed(() => ""))
/** Playbooks from a business's plugins, for the composer. */
export const pluginPlaybooks = (accountId: string, businessId: string) => Effect.map(activePlugins(accountId, businessId), list =>
  list.flatMap(p => (p.playbooks ?? []).map((x): Playbook => ({ name: x.name, title: x.title, prompt: x.prompt, area: p.title, builtIn: true }))))
  .pipe(Effect.orElseSucceed((): Playbook[] => []))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RESERVED = new Set(["setup", "status", "plan", "report", ...BUILT_IN_PLAYBOOKS.map(p => p.name)])

export const pluginsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const fail = (e: unknown) => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "PluginsUnavailable" })
  const forBusiness = <E, R>(run: (s: Session, businessId: string, name: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (!UUID.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(s.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      return yield* run(s, businessId, params["name"] ?? "")
    })).pipe(Effect.catchAll(fail))
  const catalog = (accountId: string, businessId: string) => Effect.gen(function*() {
    const own = yield* ownPlugins(accountId), on = new Set(yield* enabledFor(businessId))
    const row = (m: Manifest, source: "OPENRECORD" | "YOURS") => ({ ...m, source, enabled: on.has(m.name), playbookCount: m.playbooks?.length ?? 0 })
    return { plugins: [...BUILT_IN_PLUGINS.map(m => row(m, "OPENRECORD")), ...own.map(m => row(m, "YOURS"))] }
  })
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/plugins", forBusiness((s, businessId) => Effect.flatMap(catalog(s.accountId, businessId), b => json(200, b, { "cache-control": "no-store" })))),
    HttpRouter.post("/api/businesses/:id/plugins/:name", forBusiness((s, businessId, name) => Effect.gen(function*() {
      const exists = builtIn(name) ?? (yield* ownPlugins(s.accountId)).find(p => p.name === name)
      if (!exists) return yield* json(404, { _tag: "PluginNotFound" })
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO business_plugins(business_id, account_id, plugin, enabled_by_user_id) VALUES (${businessId}, ${s.accountId}, ${name}, ${s.userId}) ON CONFLICT (business_id, plugin) DO NOTHING`
      return yield* json(200, yield* catalog(s.accountId, businessId))
    }))),
    HttpRouter.del("/api/businesses/:id/plugins/:name", forBusiness((s, businessId, name) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM business_plugins WHERE business_id = ${businessId} AND plugin = ${name}`
      return yield* json(200, yield* catalog(s.accountId, businessId))
    }))),
    HttpRouter.put("/api/plugins/:name", operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const name = params["name"] ?? ""
      const m = decode(Manifest, yield* readJson)
      if (!m || m.name !== name) return yield* json(422, { _tag: "InvalidManifest", rule: "name, title, description and version (x.y.z) are required; the name must match the address" })
      if (builtIn(name)) return yield* json(409, { _tag: "NameTaken" })
      const clash = (m.playbooks ?? []).find(p => RESERVED.has(p.name) || BUILT_IN_PLUGINS.some(b => b.playbooks?.some(x => x.name === p.name)))
      if (clash) return yield* json(409, { _tag: "PlaybookNameTaken", name: clash.name })
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO agent_plugins(account_id, name, manifest, created_by_user_id) VALUES (${s.accountId}, ${name}, ${JSON.stringify(m)}::jsonb, ${s.userId})
        ON CONFLICT (account_id, name) DO UPDATE SET manifest = EXCLUDED.manifest, updated_at = now()`
      return yield* json(200, { installed: name })
    })).pipe(Effect.catchAll(fail))),
    HttpRouter.del("/api/plugins/:name", operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const name = params["name"] ?? ""
      const sql = yield* SqlClient.SqlClient
      const gone = yield* sql`DELETE FROM agent_plugins WHERE account_id = ${s.accountId} AND name = ${name} RETURNING name`
      if (gone.length) yield* sql`DELETE FROM business_plugins WHERE account_id = ${s.accountId} AND plugin = ${name}`
      return yield* json(gone.length ? 200 : 404, gone.length ? { uninstalled: name } : { _tag: "PluginNotFound" })
    })).pipe(Effect.catchAll(fail))),
  )
}
