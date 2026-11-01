// Company signals outside the website's own pages:
//
//  - domain.registration: when the domain was registered and by which
//    registrar, from the registry itself (RDAP, located through IANA's
//    bootstrap file). Domain age is not company age.
//  - domain.dns: the mail provider and the verification records SaaS tools ask
//    a domain owner to publish, which show which workplace, marketing, email
//    and advertising tools the company has set up.
//  - company.jobs: open roles from the careers page and its public job board,
//    grouped by team. Hiring for marketing or sales is a growth signal, not a
//    growth measurement.
import { Effect, Schema } from "effect"
import { clean, isoDate, jsonLd, links, sameSite, typesOf } from "./html.js"
import { Domain, normalizeDomain } from "./inputs.js"
import { allowRdapHost, type ResearchNetService } from "./net.js"
import { MAIL_PROVIDERS, NS_HOSTS, SPF_SENDERS, TXT_SIGNALS } from "./signatures.js"
import { readHome } from "./site.js"
import { refuse, type AnyCapability, type Observed, type Refused } from "./types.js"

// ---------------------------------------------------------------- registration

let bootstrap: Promise<ReadonlyArray<readonly [ReadonlyArray<string>, ReadonlyArray<string>]> | null> | null = null
const rdapBootstrap = (net: ResearchNetService) => bootstrap ??= net.api("https://data.iana.org/rdap/dns.json", "json").then(r => {
  try { const j = JSON.parse(r.body ?? "") as { services?: Array<[string[], string[]]> }; return Array.isArray(j.services) ? j.services : null } catch { return null }
}).then(v => { if (!v) bootstrap = null; return v })
/** Reset between tests. */
export const resetRdapBootstrap = () => { bootstrap = null }

const registrationRun = async (net: ResearchNetService, domain: string): Promise<Observed | Refused> => {
  const services = await rdapBootstrap(net)
  if (!services) return refuse("UNAVAILABLE", "The registry directory did not answer. Say registration data is unknown.")
  const labels = domain.split(".")
  let server: string | null = null
  for (let i = 0; i < labels.length && !server; i++) {
    const tld = labels.slice(i).join(".")
    const hit = services.find(([tlds]) => tlds.includes(tld))
    if (hit) server = hit[1].find(u => u.startsWith("https://")) ?? null
  }
  if (!server) return { status: "NO_DATA", findings: {}, coverage: { note: "This domain's registry publishes no RDAP service. Registration data is unknown." } }
  const host = new URL(server).hostname
  allowRdapHost(host)
  const r = await net.api(`${server.replace(/\/$/, "")}/domain/${encodeURIComponent(domain)}`, "json")
  if (r.status === 404) return { status: "NO_DATA", findings: {}, coverage: { note: "The registry has no record for this domain (it may be a subdomain)." } }
  if (r.status === 429) return refuse("RATE_LIMITED", "The registry asked OpenRecord to slow down. Try again later.")
  if (!r.body || r.status !== 200) return refuse("UNAVAILABLE", "The registry did not answer.")
  let j: { events?: Array<{ eventAction?: string; eventDate?: string }>; entities?: Array<{ roles?: string[]; vcardArray?: unknown }>; status?: string[] }
  try { j = JSON.parse(r.body) } catch { return refuse("MALFORMED", "The registry's answer could not be read.") }
  const ev = (action: string) => isoDate(j.events?.find(e => e.eventAction === action)?.eventDate)
  const registrarCard = j.entities?.find(e => e.roles?.includes("registrar"))?.vcardArray
  const registrar = Array.isArray(registrarCard) && Array.isArray(registrarCard[1]) ? clean((registrarCard[1] as unknown[][]).find(f => f[0] === "fn")?.[3], 120) : null
  const created = ev("registration")
  return {
    status: "OBSERVED", citations: [{ kind: "web", id: `${server.replace(/\/$/, "")}/domain/${domain}`, text: `Registry record for ${domain}` }],
    timeline: created ? [{ date: created, event: `Domain ${domain} registered`, label: "SEEN" }] : [],
    findings: { label: "SEEN", registered: created, lastChanged: ev("last changed"), expires: ev("expiration"), registrar, status: (j.status ?? []).slice(0, 6),
      domainAgeYears: created ? Math.floor((Date.now() - Date.parse(created)) / (365.25 * 86_400_000)) : null },
    coverage: { registry: host, note: "From the domain's registry. A domain can be bought long before (or after) the company starts; domain age is not company age." },
  }
}

// ---------------------------------------------------------------- DNS

const dnsRun = async (net: ResearchNetService, domain: string): Promise<Observed | Refused> => {
  const rec = await net.dns(domain)
  if (!rec.mx.length && !rec.txt.length && !rec.ns.length) return { status: "NO_DATA", findings: {}, coverage: { note: "No public DNS records answered for this domain." } }
  const mail = [...new Set(rec.mx.flatMap(mx => MAIL_PROVIDERS.filter(([re]) => re.test(mx)).map(([, n]) => n)))]
  const verifications = rec.txt.flatMap(t => TXT_SIGNALS.filter(([re]) => re.test(t)).map(([, tool, area]) => ({ tool, area })))
  const spf = rec.txt.find(t => /^v=spf1/i.test(t)) ?? ""
  const senders = SPF_SENDERS.filter(([re]) => re.test(spf)).map(([, tool, area]) => ({ tool, area }))
  const dnsHost = [...new Set(rec.ns.flatMap(ns => NS_HOSTS.filter(([re]) => re.test(ns)).map(([, n]) => n)))]
  const tools = [...new Map([...verifications, ...senders].map(t => [t.tool, t])).values()]
  return {
    status: "OBSERVED", citations: [],
    findings: { label: "SEEN", mailProvider: mail, dnsHosting: dnsHost, tools, records: { mx: rec.mx.slice(0, 6), ns: rec.ns.slice(0, 6), spf: clean(spf, 400), wwwAlias: rec.cname.slice(0, 2) },
      marketingSignals: { label: "INFERRED", tools: tools.filter(t => /marketing|email|social|search/i.test(t.area)).map(t => `${t.tool} (${t.area})`) } },
    coverage: { note: "Public DNS records right now. A verification record proves the company set a tool up at some point; old records are rarely removed, so it is not proof of current use." },
  }
}

// ---------------------------------------------------------------- jobs

const TEAMS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Marketing", /market|growth|seo|content|brand|demand gen|social media|community|communications|pr\b|copywrit|lifecycle|acquisition/i],
  ["Sales", /sales|account executive|\bae\b|sdr|bdr|business development|account manager|partnership|revenue/i],
  ["Customer success", /customer success|support|onboarding|implementation|solutions/i],
  ["Engineering", /engineer|developer|devops|sre|architect|software|data scien|machine learning|\bml\b|security/i],
  ["Product and design", /product|design|ux|ui\b|research/i],
  ["Operations and finance", /operations|finance|account(ant|ing)|legal|hr\b|people|talent|recruit|office/i],
]
const teamOf = (title: string, dept: string | null) => TEAMS.find(([, re]) => re.test(`${dept ?? ""} ${title}`))?.[0] ?? "Other"
interface Job { readonly title: string; readonly team: string; readonly location: string | null; readonly posted: string | null; readonly url: string | null }

const BOARDS: ReadonlyArray<{ readonly re: RegExp; readonly api: (token: string) => string; readonly parse: (j: unknown) => Job[] }> = [
  { re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, api: t => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=false`,
    parse: j => ((j as { jobs?: unknown[] }).jobs ?? []).map(x => { const o = x as Record<string, unknown>; const dept = clean(((o["departments"] as Array<{ name?: string }> | undefined)?.[0])?.name, 60)
      return { title: clean(o["title"], 140) ?? "", team: teamOf(String(o["title"] ?? ""), dept), location: clean((o["location"] as { name?: string } | undefined)?.name, 80), posted: isoDate(o["updated_at"]), url: clean(o["absolute_url"], 400) } }) },
  { re: /jobs\.lever\.co\/([a-z0-9_-]+)/i, api: t => `https://api.lever.co/v0/postings/${t}?mode=json`,
    parse: j => (Array.isArray(j) ? j : []).map(x => { const o = x as Record<string, unknown>, c = (o["categories"] ?? {}) as Record<string, unknown>
      return { title: clean(o["text"], 140) ?? "", team: teamOf(String(o["text"] ?? ""), clean(c["team"] ?? c["department"], 60)), location: clean(c["location"], 80), posted: typeof o["createdAt"] === "number" ? new Date(o["createdAt"]).toISOString() : null, url: clean(o["hostedUrl"], 400) } }) },
  { re: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i, api: t => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    parse: j => ((j as { jobs?: unknown[] }).jobs ?? []).map(x => { const o = x as Record<string, unknown>
      return { title: clean(o["title"], 140) ?? "", team: teamOf(String(o["title"] ?? ""), clean(o["department"] ?? o["team"], 60)), location: clean(o["location"], 80), posted: isoDate(o["publishedAt"]), url: clean(o["jobUrl"], 400) } }) },
  { re: /apply\.workable\.com\/([a-z0-9_-]+)/i, api: t => `https://apply.workable.com/api/v1/widget/accounts/${t}`,
    parse: j => ((j as { jobs?: unknown[] }).jobs ?? []).map(x => { const o = x as Record<string, unknown>
      return { title: clean(o["title"], 140) ?? "", team: teamOf(String(o["title"] ?? ""), clean(o["department"], 60)), location: clean([o["city"], o["country"]].filter(Boolean).join(", "), 80), posted: isoDate(o["published_on"] ?? o["created_at"]), url: clean(o["url"], 400) } }) },
]

const jobsRun = async (net: ResearchNetService, domain: string, now: Date): Promise<Observed | Refused> => {
  const p = await readHome(net, domain)
  if (p.state !== "OK" || !p.body) return refuse("UNREADABLE", "The home page could not be read, so the careers page could not be found.")
  const homeLinks = links(p.body, p.finalUrl)
  const careers = homeLinks.find(l => /\/(careers|jobs|join-us|join|work-with-us|hiring)(\/|$)/i.test(l.href) || /^(careers|jobs|we.?re hiring|join (us|our team))$/i.test(l.text))
  let pageLinks = homeLinks.map(l => l.href), careersUrl: string | null = null, postingsFromPage: Job[] = []
  if (careers) {
    const c = await net.page(careers.href)
    if (c.state === "OK" && c.body) {
      careersUrl = c.finalUrl
      pageLinks = [...pageLinks, ...links(c.body, c.finalUrl).map(l => l.href), ...[...c.body.matchAll(/https?:\/\/[^"'\s<>]+/g)].map(m => m[0])]
      postingsFromPage = jsonLd(c.body).filter(o => typesOf(o).includes("JobPosting")).map(o => ({ title: clean(o["title"], 140) ?? "", team: teamOf(String(o["title"] ?? ""), null), location: null, posted: isoDate(o["datePosted"]), url: careersUrl }))
    } else if (sameSite(careers.href, domain)) careersUrl = careers.href
    else pageLinks.push(careers.href)
  }
  let jobs: Job[] = postingsFromPage, board: string | null = null
  for (const b of BOARDS) {
    const token = pageLinks.map(h => h.match(b.re)?.[1]).find(Boolean)
    if (!token) continue
    const r = await net.api(b.api(token), "json")
    if (r.status === 200 && r.body) { try { jobs = b.parse(JSON.parse(r.body)).filter(j => j.title); board = new URL(b.api(token)).hostname } catch { /* unreadable board */ } }
    break
  }
  if (!careersUrl && !board) return { status: "NO_DATA", findings: {}, coverage: { note: "No careers page or public job board linked from the home page. Unknown, not zero openings." } }
  if (!board && !jobs.length) return { status: "NO_DATA", citations: careersUrl ? [{ kind: "web", id: careersUrl, text: `Careers page of ${domain}` }] : [],
    findings: { label: "SEEN", careersPage: careersUrl, openings: null },
    coverage: { note: "A careers page exists, but its roles load from a source OpenRecord could not read (often a script or an unlisted job board). Openings are unknown, not zero." } }
  const byTeam: Record<string, number> = {}
  for (const j of jobs) byTeam[j.team] = (byTeam[j.team] ?? 0) + 1
  const recent = jobs.filter(j => j.posted && now.getTime() - Date.parse(j.posted) < 60 * 86_400_000).length
  return {
    status: jobs.length ? "OBSERVED" : "NO_DATA",
    citations: careersUrl ? [{ kind: "web", id: careersUrl, text: `Careers page of ${domain}` }] : [],
    timeline: jobs.filter(j => j.posted && /Marketing|Sales/.test(j.team)).slice(0, 15).map(j => ({ date: j.posted!, event: `Job posted (${j.team}): ${j.title}`, label: "SEEN" as const, url: j.url })),
    findings: { label: "SEEN", openings: jobs.length, byTeam, postedLast60Days: recent, careersPage: careersUrl, board, roles: jobs.slice(0, 40).map(j => ({ ...j, posted: j.posted?.slice(0, 10) ?? null })),
      growthSignal: { label: "INFERRED", marketingAndSales: (byTeam["Marketing"] ?? 0) + (byTeam["Sales"] ?? 0),
        note: "Open marketing and sales roles suggest investment in those channels; hiring plans change and listings can stay up after a role is filled." } },
    coverage: { source: board ? `public job board (${board})` : "careers page", note: "Openings listed today. Dates are the board's posting or update dates. Some companies list roles only elsewhere; not listed is not not hiring." },
  }
}

const DomainOnly = Schema.Struct({ domain: Domain })
const subject = (i: typeof DomainOnly.Type) => normalizeDomain(i.domain)!
export const COMPANY_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "domain.registration", platform: "company", title: "Domain registration and age", source: "PUBLIC_REGISTRY", label: "SEEN", cache: "day",
    description: "Registration, last-change and expiry dates and the registrar, from the domain's registry (RDAP).",
    input: DomainOnly, subject, run: (ctx, i: typeof DomainOnly.Type) => Effect.tryPromise(() => registrationRun(ctx.net, subject(i))) },
  { id: "domain.dns", platform: "company", title: "Mail, workplace and marketing tools from DNS", source: "PUBLIC_REGISTRY", label: "SEEN", cache: "day",
    description: "Mail provider, DNS hosting, and the tools the domain verified or sends email through (search, advertising, marketing automation, email marketing, CRM, support, workplace), from public DNS records.",
    input: DomainOnly, subject, run: (ctx, i: typeof DomainOnly.Type) => Effect.tryPromise(() => dnsRun(ctx.net, subject(i))) },
  { id: "company.jobs", platform: "company", title: "Hiring: open roles by team", source: "PUBLIC_WEB", label: "SEEN", cache: "day",
    description: "Open roles from the careers page and its public job board, grouped by team (marketing, sales, customer success, engineering, product, operations), with posting dates and the roles posted in the last 60 days.",
    input: DomainOnly, subject, run: (ctx, i: typeof DomainOnly.Type) => Effect.tryPromise(() => jobsRun(ctx.net, subject(i), ctx.now)) },
]
