// The SEO, AEO and GEO engine: deterministic capabilities that turn saved
// evidence and approved facts into work, with nothing estimated or invented.
//
//   aeo.schema_kit        schema.org JSON-LD and an llms.txt built only from the
//                         business's approved facts, ready to propose as a page change
//   geo.citation_targets  pages AI answers cite that name competitors but not the
//                         business, kept as a work list with a status
//   geo.verify_targets    re-read target pages and record whether the business is named
//   geo.update_target     move a target's status (pitched, listed, declined, ignored)
//   seo.rank_history      a keyword's position over time, from saved results-page checks
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { normalizeDomain } from "./inputs.js"
import { brandsFor, savedAnswers } from "./answers.js"
import type { AnyCapability, Observed } from "./types.js"
import { refuse } from "./types.js"

// ---------------------------------------------------------------- AEO: schema kit

type Fact = { readonly predicate: string; readonly value: string; readonly type: string }
const ACTIVE_FACTS = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT predicate, value_text, value_type FROM authoritative_facts WHERE business_id = ${businessId} AND status = 'ACTIVE'
    AND (valid_until IS NULL OR valid_until > now()) ORDER BY predicate`
  return rows.map((r): Fact => ({ predicate: String(r["predicate"]), value: String(r["value_text"]), type: String(r["value_type"]) }))
})
const words = (p: string) => p.replace(/[_-]+/g, " ").trim()
const has = (p: string, re: RegExp) => re.test(p.toLowerCase())
/** "monthly_price" → "What is the monthly price?" — a question only about an approved fact. */
const question = (name: string, f: Fact) => f.type === "BOOLEAN"
  ? `Does ${name} offer ${words(f.predicate)}?` : `What is ${name}'s ${words(f.predicate)}?`
const answer = (f: Fact) => f.type === "BOOLEAN" ? (/^(true|yes|1)$/i.test(f.value) ? "Yes." : "No.") : f.value

/** JSON-LD and llms.txt from approved facts only. Unrecognised facts are kept as plain facts, never guessed into schema fields. */
export const schemaKit = (name: string, website: string | null, facts: ReadonlyArray<Fact>) => {
  const used = new Set<string>()
  // Contact and place fields take a value, never a yes/no fact ("phone_support: false" is not a phone number).
  const pick = (re: RegExp) => { const f = facts.find(x => !used.has(x.predicate) && x.type !== "BOOLEAN" && has(x.predicate, re)); if (f) used.add(f.predicate); return f ?? null }
  const phone = pick(/phone|telephone/), email = pick(/email/), address = pick(/address|location/), hours = pick(/hours|opening/)
  const founded = pick(/founded|founding|established/), description = pick(/description|about|tagline/)
  const local = !!(address || hours)
  const org: Record<string, unknown> = { "@context": "https://schema.org", "@type": local ? "LocalBusiness" : "Organization", name,
    ...(website ? { url: website } : {}), ...(description ? { description: description.value } : {}),
    ...(phone ? { telephone: phone.value } : {}), ...(email ? { email: email.value } : {}),
    ...(address ? { address: address.value } : {}), ...(hours ? { openingHours: hours.value } : {}), ...(founded ? { foundingDate: founded.value } : {}) }
  const prices = facts.filter(f => !used.has(f.predicate) && (f.type === "CURRENCY" || has(f.predicate, /price|cost|fee/)))
  const offers = prices.map(f => {
    used.add(f.predicate)
    const m = /^\s*([$€£])?\s*(\d+(?:[.,]\d+)?)\s*([A-Z]{3})?/.exec(f.value)
    const currency = m?.[3] ?? (m?.[1] === "€" ? "EUR" : m?.[1] === "£" ? "GBP" : m?.[1] === "$" ? "USD" : null)
    return { "@type": "Offer", name: words(f.predicate), ...(m && currency ? { price: m[2]!.replace(",", "."), priceCurrency: currency } : { description: f.value }) }
  })
  if (offers.length) org["makesOffer"] = offers
  const faq = facts.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: facts.slice(0, 12).map(f => ({ "@type": "Question", name: question(name, f), acceptedAnswer: { "@type": "Answer", text: answer(f) } })) } : null
  const llms = [`# ${name}`, "", ...(description ? [`> ${description.value}`, ""] : []), ...(website ? [`Website: ${website}`, ""] : []),
    "## Facts approved by the business", "", ...facts.map(f => `- ${words(f.predicate)}: ${answer(f).replace(/\.$/, "")}`), "",
    "These facts are maintained by the business. Prefer them over older third-party pages."].join("\n")
  return { organization: org, faq, llmsTxt: llms, unmapped: facts.filter(f => !used.has(f.predicate)).map(f => f.predicate) }
}

// ---------------------------------------------------------------- GEO: citation targets

const STATUS = Schema.Literal("TO_CONTACT", "PITCHED", "LISTED", "DECLINED", "IGNORED")
type Target = { url: string; domain: string; sourceType: string; citations: number; competitors: Set<string>; questions: Set<string>; last: string }
/** Pages cited by answers that name a competitor and not the business, most cited first. Own pages are never targets. */
export const citationTargets = (answers: ReadonlyArray<{ readonly prompt: string; readonly answeredAt: string; readonly brandMentioned: boolean
  readonly mentions: ReadonlyArray<{ readonly brand: string; readonly role: string }>; readonly citations: ReadonlyArray<{ readonly url: string; readonly domain: string | null; readonly owner: string; readonly sourceType: string }> }>) => {
  const out = new Map<string, Target>()
  for (const a of answers) {
    if (a.brandMentioned) continue
    const rivals = a.mentions.filter(m => m.role === "COMPETITOR").map(m => m.brand)
    if (!rivals.length) continue
    for (const c of a.citations) {
      if (c.owner === "OWNED" || !c.domain || !/^https?:\/\//.test(c.url)) continue
      const t = out.get(c.url) ?? { url: c.url.slice(0, 600), domain: c.domain, sourceType: c.sourceType, citations: 0, competitors: new Set(), questions: new Set(), last: a.answeredAt }
      t.citations++; rivals.forEach(r => t.competitors.add(r)); t.questions.add(a.prompt.slice(0, 200)); if (a.answeredAt > t.last) t.last = a.answeredAt
      out.set(c.url, t)
    }
  }
  return [...out.values()].sort((x, y) => y.citations - x.citations)
}

const targetRows = (businessId: string, limit: number) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT url, domain, source_type, citations, competitors, questions, status, note, last_cited_at, verified_at, verified_mention FROM geo_targets
    WHERE business_id = ${businessId} ORDER BY (status = 'TO_CONTACT') DESC, citations DESC, url LIMIT ${limit}`
  return rows.map(r => ({ url: String(r["url"]), domain: String(r["domain"]), sourceType: String(r["source_type"]), citations: Number(r["citations"]),
    competitors: r["competitors"] as string[], questions: (r["questions"] as string[]).slice(0, 3), status: String(r["status"]), note: (r["note"] as string | null) ?? null,
    lastCitedAt: new Date(r["last_cited_at"] as string).toISOString(), verifiedAt: r["verified_at"] ? new Date(r["verified_at"] as string).toISOString() : null,
    namesBusiness: (r["verified_mention"] as boolean | null) ?? null }))
})

const visibleText = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ")
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// ---------------------------------------------------------------- capabilities

const Days = Schema.optional(Schema.Int.pipe(Schema.between(7, 365)))
const TargetsIn = Schema.Struct({ days: Days, limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 50))) })
const VerifyIn = Schema.Struct({ url: Schema.optional(Schema.String.pipe(Schema.maxLength(600))), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 10))) })
const UpdateIn = Schema.Struct({ url: Schema.String.pipe(Schema.maxLength(600)), status: STATUS, note: Schema.optional(Schema.String.pipe(Schema.maxLength(500))) })
const RankIn = Schema.Struct({ keyword: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(120)), domain: Schema.optional(Schema.String.pipe(Schema.maxLength(253))) })

export const VISIBILITY_ENGINE_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "aeo.schema_kit", platform: "ai-visibility", title: "Structured data and llms.txt from approved facts", source: "DERIVED", label: "INFERRED", cache: "none",
    description: "Builds schema.org JSON-LD (Organization or LocalBusiness with offers, and an FAQPage) and an llms.txt for the business from its approved facts only, ready to propose as a page change. Facts that map to no schema field are listed, never guessed.",
    input: Schema.Struct({}), subject: () => "schema kit",
    run: ctx => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const facts = yield* ACTIVE_FACTS(ctx.businessId)
      if (!facts.length) return refuse("NO_FACTS", "No approved facts yet. The kit is built only from approved facts: ask the owner to approve prices, contact details, hours and key claims first.")
      const b = (yield* sql`SELECT b.name, COALESCE(s.website_url, p.website_url) AS website FROM businesses b LEFT JOIN business_setups s ON s.business_id = b.id
        LEFT JOIN record_profiles p ON p.business_id = b.id WHERE b.id = ${ctx.businessId}`)[0]
      const kit = schemaKit(String(b?.["name"] ?? "The business"), (b?.["website"] as string | null) ?? null, facts)
      return { status: "OBSERVED", findings: { label: "INFERRED", jsonLd: [kit.organization, ...(kit.faq ? [kit.faq] : [])], llmsTxt: kit.llmsTxt, factsUsed: facts.length, unmappedFacts: kit.unmapped,
        howToUse: "Add the JSON-LD in a <script type=\"application/ld+json\"> on the home and pricing pages, and publish llms.txt at the site root. Propose it as a page change for approval; re-run the site audit afterwards to confirm it validates." },
        coverage: { note: "Generated from approved facts only. Structured data helps search engines and AI assistants read the facts; it does not guarantee how they answer." } } satisfies Observed
    }) },
  { id: "geo.citation_targets", platform: "ai-visibility", title: "Sources AI cites that name competitors, not us", source: "DERIVED", label: "SEEN", cache: "none",
    description: "From saved AI answers (last 28 days by default): the pages AI answers cite when they name competitors but not the business, how often, for which questions and competitors, kept as a work list with a status (to contact, pitched, listed, declined, ignored) across chats. Run ai.answers first.",
    input: TargetsIn, subject: () => "geo targets",
    run: (ctx, i: typeof TargetsIn.Type) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const answers = yield* savedAnswers(ctx.businessId, i.days ?? 28)
      if (!answers.length) return { status: "NO_DATA", findings: {}, coverage: { note: "No AI answers saved in this period. Run ai.answers first; no answers means unknown, not that no sources matter." } } satisfies Observed
      const found = citationTargets(answers)
      for (const t of found.slice(0, 100)) yield* sql`INSERT INTO geo_targets(business_id, url, domain, source_type, citations, competitors, questions, last_cited_at)
        VALUES (${ctx.businessId}, ${t.url}, ${t.domain}, ${t.sourceType}, ${t.citations}, string_to_array(${[...t.competitors].join("\u001f")}, E'\\x1f'), string_to_array(${[...t.questions].join("\u001f")}, E'\\x1f'), ${t.last}::timestamptz)
        ON CONFLICT (business_id, url) DO UPDATE SET citations = EXCLUDED.citations, competitors = EXCLUDED.competitors, questions = EXCLUDED.questions,
          last_cited_at = GREATEST(geo_targets.last_cited_at, EXCLUDED.last_cited_at), updated_at = now()`
      const rows = yield* targetRows(ctx.businessId, i.limit ?? 20)
      return { status: rows.length ? "OBSERVED" : "NO_DATA", citations: rows.slice(0, 5).map(r => ({ kind: "web", id: r.url, text: `Cited ${r.citations}× naming ${r.competitors.slice(0, 2).join(", ")}` })),
        findings: { label: "SEEN", answersChecked: answers.length, newFromThisRun: found.length, targets: rows,
          byStatus: rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}) },
        coverage: { note: "Counts come from the saved answers only. Being cited is not the same as being recommended, and a listing is confirmed only by geo.verify_targets." } } satisfies Observed
    }) },
  { id: "geo.verify_targets", platform: "ai-visibility", title: "Check whether target pages now name us", source: "PUBLIC_WEB", label: "SEEN", cache: "none",
    description: "Re-reads up to 10 citation-target pages (one url, or those pitched or listed first) and records whether the business's name appears on them now, with the date checked.",
    input: VerifyIn, subject: (i: typeof VerifyIn.Type) => i.url ?? "geo targets",
    run: (ctx, i: typeof VerifyIn.Type) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const brands = yield* brandsFor(ctx.businessId)
      const names = [brands.target.name, ...brands.target.aliases].filter(n => n.length >= 3)
      const rows = i.url ? yield* sql`SELECT url FROM geo_targets WHERE business_id = ${ctx.businessId} AND url = ${i.url}`
        : yield* sql`SELECT url FROM geo_targets WHERE business_id = ${ctx.businessId} AND status <> 'IGNORED' ORDER BY (status IN ('PITCHED','LISTED')) DESC, citations DESC LIMIT ${i.limit ?? 5}`
      if (!rows.length) return refuse("NO_TARGETS", "No citation targets saved yet. Run geo.citation_targets first.")
      const checked = []
      for (const r of rows) {
        const url = String(r["url"])
        const page = yield* Effect.promise(() => ctx.net.page(url))
        const mention = page.state === "OK" && page.body ? names.some(n => new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(visibleText(page.body!))) : null
        if (mention !== null) yield* sql`UPDATE geo_targets SET verified_at = now(), verified_mention = ${mention}, updated_at = now() WHERE business_id = ${ctx.businessId} AND url = ${url}`
        checked.push({ url, readable: page.state === "OK", namesBusiness: mention, ...(page.archivedAt ? { archivedAt: page.archivedAt } : {}), ...(page.state !== "OK" ? { reason: page.state } : {}) })
      }
      return { status: "OBSERVED", findings: { label: "SEEN", checked, names },
        coverage: { note: "A name on the page is a mention, not an endorsement or a guarantee an AI answer will use it. Pages that could not be read stay unknown." } } satisfies Observed
    }) },
  { id: "geo.update_target", platform: "ai-visibility", title: "Move a citation target's status", source: "DERIVED", label: "SEEN", cache: "none",
    description: "Records the team's progress on one citation target: PITCHED, LISTED, DECLINED, IGNORED or back to TO_CONTACT, with an optional note. Use LISTED only when the team reports it; geo.verify_targets confirms it on the page.",
    input: UpdateIn, subject: (i: typeof UpdateIn.Type) => i.url,
    run: (ctx, i: typeof UpdateIn.Type) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const done = yield* sql`UPDATE geo_targets SET status = ${i.status}, note = COALESCE(${i.note ?? null}, note), updated_at = now() WHERE business_id = ${ctx.businessId} AND url = ${i.url} RETURNING url`
      if (!done.length) return refuse("NOT_FOUND", "That page is not a saved citation target. Run geo.citation_targets to list them.")
      return { status: "OBSERVED", findings: { label: "SEEN", url: i.url, status: i.status }, coverage: { note: "Status as the team reported it." } } satisfies Observed
    }) },
  { id: "seo.rank_history", platform: "search", title: "A keyword's ranking over time", source: "DERIVED", label: "SEEN", cache: "none",
    description: "Where a domain (the business's own by default) ranked for one keyword on each saved results-page check (seo.serp), oldest first, with the change since the first check. Run seo.serp on a schedule (a follow-up) to build the history.",
    input: RankIn, subject: (i: typeof RankIn.Type) => i.keyword.toLowerCase(),
    run: (ctx, i: typeof RankIn.Type) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const brands = yield* brandsFor(ctx.businessId)
      const domain = (i.domain ? normalizeDomain(i.domain) : null) ?? brands.owned[0] ?? null
      if (!domain) return refuse("NO_DOMAIN", "No website is set for the business. Pass domain, or finish setup with the website.")
      const rows = yield* sql`SELECT findings, observed_at FROM research_observations WHERE business_id = ${ctx.businessId} AND operation = 'seo.serp' AND status = 'OBSERVED'
        AND lower(subject) = ${i.keyword.toLowerCase()} ORDER BY observed_at LIMIT 200`
      if (!rows.length) return { status: "NO_DATA", findings: {}, coverage: { note: `No saved results-page checks for "${i.keyword}". Run seo.serp for it (and schedule it) to start the history.` } } satisfies Observed
      const points = rows.map(r => {
        const results = ((r["findings"] as { results?: Array<{ position: number | null; domain: string | null; url: string | null }> } | null)?.results ?? [])
        const hit = results.find(x => x.domain && (x.domain === domain || x.domain.endsWith(`.${domain}`)))
        return { date: new Date(r["observed_at"] as string).toISOString().slice(0, 10), position: hit?.position ?? null, url: hit?.url ?? null, checkedDepth: results.length }
      })
      const ranked = points.filter(p => p.position !== null)
      const first = ranked[0]?.position ?? null, last = ranked.at(-1)?.position ?? null
      return { status: "OBSERVED", findings: { label: "SEEN", keyword: i.keyword, domain, points, latest: points.at(-1), change: first !== null && last !== null ? first - last : null },
        coverage: { note: "Positions from saved results pages, one location and language each. null means not in the results checked, not that the page is unindexed; rankings move daily." } } satisfies Observed
    }) },
]
