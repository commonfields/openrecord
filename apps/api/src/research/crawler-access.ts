// Whether AI crawlers can actually read the business's own website. robots.txt
// can allow them while a firewall, CDN or bot-protection rule still refuses
// them, which keeps the site out of AI answers no matter how good its pages
// are. This reads the home page once as a normal browser and once as each
// major AI crawler and assistant fetcher, and compares the answers.
//
// Only for the business's own website (its owner is entitled to test how the
// site treats these crawlers). Requests come from OpenRecord's server, not the
// crawler operators' published addresses, so a site that verifies crawler IP
// ranges may treat the real crawler differently; a block here is strong
// evidence, an allow is not a guarantee.
import { Effect, Option, Schema } from "effect"
import { safeFetch } from "@openrecord/representation"
import { businessWebsite } from "../agent-web-tools.js"
import { normalizeDomain } from "./inputs.js"
import { ResearchHttp } from "./net.js"
import { refuse, type AnyCapability, type Observed } from "./types.js"

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"
export const AI_AGENTS: ReadonlyArray<{ readonly name: string; readonly owner: string; readonly use: string; readonly ua: string }> = [
  { name: "GPTBot", owner: "OpenAI", use: "training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot" },
  { name: "OAI-SearchBot", owner: "OpenAI", use: "ChatGPT search", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot" },
  { name: "ChatGPT-User", owner: "OpenAI", use: "fetching for a ChatGPT user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" },
  { name: "ClaudeBot", owner: "Anthropic", use: "training", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ClaudeBot/1.0; +claudebot@anthropic.com" },
  { name: "Claude-User", owner: "Anthropic", use: "fetching for a Claude user", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Claude-User/1.0; +Claude-User@anthropic.com" },
  { name: "PerplexityBot", owner: "Perplexity", use: "Perplexity search", ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot" },
  { name: "Googlebot", owner: "Google", use: "Google Search and AI Overviews", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { name: "Bingbot", owner: "Microsoft", use: "Bing and Copilot", ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
  { name: "Applebot", owner: "Apple", use: "Siri and Spotlight", ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)" },
]

/** url or domain of the business's own site; both are optional (the recorded website is used). */
const Input = Schema.Struct({ url: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))), domain: Schema.optional(Schema.String.pipe(Schema.maxLength(253))) })
const run = (ctx: { businessId: string }, input: typeof Input.Type) => Effect.gen(function*() {
  const own = yield* businessWebsite(ctx.businessId)
  const ownDomain = own ? normalizeDomain(own) : null
  if (!ownDomain) return refuse("NO_WEBSITE", "No website is recorded for this business, so its crawler access cannot be tested.")
  const target = input.url ?? (input.domain ? `https://${normalizeDomain(input.domain) ?? input.domain}/` : own!)
  if (normalizeDomain(target) !== ownDomain) return refuse("NOT_OWN_SITE", "This check only tests the business's own website.")
  const transport = Option.getOrUndefined(yield* Effect.serviceOption(ResearchHttp))
  const read = (ua: string) => Effect.promise(() => safeFetch(target, { ...(transport ? { transport } : {}), userAgent: ua,
    limits: { timeoutMs: 12_000, maxRedirects: 5, maxBytes: 2_000_000, acceptedContentTypes: null } }).then(ev => ({ status: ev.status, bytes: ev.bodyBytes, failure: ev.failure })))
  const browser = yield* read(BROWSER)
  const agents = yield* Effect.forEach(AI_AGENTS, a => Effect.map(read(a.ua), r => ({ crawler: a.name, owner: a.owner, use: a.use, status: r.status, bytes: r.bytes })), { concurrency: 3 })
  const ok = (s: number | null) => s !== null && s >= 200 && s < 400
  const blocked = agents.filter(a => ok(browser.status) && !ok(a.status))
  const thin = agents.filter(a => ok(a.status) && browser.bytes > 0 && a.bytes < browser.bytes * 0.3)
  return {
    status: "OBSERVED",
    citations: [{ kind: "web", id: target, text: `Crawler access test of ${ownDomain}` }],
    timeline: blocked.length ? [{ date: new Date().toISOString(), event: `${blocked.length} AI crawlers refused by ${ownDomain} (${blocked.map(b => `${b.crawler} ${b.status}`).join(", ")})`, label: "SEEN" as const }] : [],
    findings: { label: "SEEN", url: target, browser: { status: browser.status, bytes: browser.bytes }, crawlers: agents,
      blocked: blocked.map(b => ({ crawler: b.crawler, owner: b.owner, use: b.use, status: b.status })),
      servedLess: thin.map(t => ({ crawler: t.crawler, bytes: t.bytes, browserBytes: browser.bytes })),
      verdict: blocked.length ? `Blocked for ${blocked.map(b => b.crawler).join(", ")} while a browser gets ${browser.status}: a firewall, CDN or bot rule is refusing them. Ask the web host to allow the verified AI crawlers.` : ok(browser.status) ? "No AI crawler was refused." : "The home page did not answer a browser either." },
    coverage: { note: "Requests sent from OpenRecord's server with each crawler's user agent, now. Sites that verify crawler IP ranges may treat the real crawlers differently: a block here is strong evidence, an allow is not a guarantee." },
  } satisfies Observed
})

export const CRAWLER_ACCESS_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "site.ai_crawler_access", platform: "website", title: "Can AI crawlers actually read our site?", source: "PUBLIC_WEB", label: "SEEN", cache: "none",
    description: "For the business's own website: reads the home page as a browser and as GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, PerplexityBot, Googlebot, Bingbot and Applebot, and reports any the site refuses (firewall, CDN or bot protection) even when robots.txt allows them.",
    input: Input, subject: () => "own site crawler access", run: (ctx, i: typeof Input.Type) => run(ctx, i) },
]
