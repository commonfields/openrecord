// Public, keyless endpoints: app store listings and reviews, podcasts,
// developer adoption (GitHub, npm, PyPI, Docker Hub), Wikipedia interest and
// Wikidata facts, and SEC filings for public companies.
import { Schema } from "effect"
import { clean, isoDate } from "../html.js"
import type { AnyEndpoint, Parsed } from "./types.js"

export const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
export const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^[+-]?\d+(\.\d+)?$/.test(v) ? Number(v) : null
export const txt = (v: unknown, max = 200) => clean(typeof v === "number" ? String(v) : v, max)
export const ok = (findings: Record<string, unknown>, coverage: Record<string, unknown> = {}): Parsed => ({ status: "OBSERVED", findings, coverage })
export const none = (note: string): Parsed => ({ status: "NO_DATA", findings: {}, coverage: { note } })
const Str = (max: number, pattern?: RegExp) => pattern ? Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max), Schema.pattern(pattern)) : Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max))
const Country = Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{2}$/)))
const Limit = (max: number) => Schema.optional(Schema.Int.pipe(Schema.between(1, max)))
const enc = encodeURIComponent
const monthKey = (iso: string) => iso.slice(0, 7)

// ---------------------------------------------------------------- Apple

const appRow = (x: unknown) => { const a = obj(x); return { id: num(a["trackId"]), name: txt(a["trackName"]), seller: txt(a["sellerName"]), rating: num(a["averageUserRating"]),
  ratings: num(a["userRatingCount"]), price: txt(a["formattedPrice"], 30), genre: txt(a["primaryGenreName"], 60), released: isoDate(a["releaseDate"])?.slice(0, 10) ?? null,
  lastUpdate: isoDate(a["currentVersionReleaseDate"])?.slice(0, 10) ?? null, version: txt(a["version"], 30), bundleId: txt(a["bundleId"], 120), url: txt(a["trackViewUrl"], 300) } }
const AppSearch = Schema.Struct({ term: Str(100), country: Country, limit: Limit(25) })
const AppLookup = Schema.Struct({ id: Schema.optional(Str(20, /^\d+$/)), bundleId: Schema.optional(Str(150, /^[A-Za-z0-9.-]+$/)), country: Country })
const AppReviews = Schema.Struct({ id: Str(20, /^\d+$/), country: Country })
const PodSearch = Schema.Struct({ term: Str(100), country: Country, limit: Limit(25) })

// ---------------------------------------------------------------- GitHub

const Org = Schema.Struct({ org: Str(39, /^[A-Za-z0-9-]+$/) })
const Repo = Schema.Struct({ owner: Str(39, /^[A-Za-z0-9-]+$/), repo: Str(100, /^[A-Za-z0-9._-]+$/) })
const RepoSearch = Schema.Struct({ query: Str(200), limit: Limit(30) })
const repoRow = (x: unknown) => { const r = obj(x); return { name: txt(r["full_name"] ?? r["name"], 140), stars: num(r["stargazers_count"]), forks: num(r["forks_count"]), openIssues: num(r["open_issues_count"]),
  language: txt(r["language"], 40), created: isoDate(r["created_at"])?.slice(0, 10) ?? null, pushed: isoDate(r["pushed_at"])?.slice(0, 10) ?? null, archived: r["archived"] === true, description: txt(r["description"], 200) } }

// ---------------------------------------------------------------- packages

const Pkg = Schema.Struct({ package: Str(214, /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i) })
const Docker = Schema.Struct({ namespace: Str(64, /^[a-z0-9._-]+$/), repository: Str(128, /^[a-z0-9._-]+$/) })

// ---------------------------------------------------------------- Wikimedia

const Title = Schema.Struct({ title: Str(200), lang: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{2,3}$/))) })
const Views = Schema.Struct({ title: Str(200), lang: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{2,3}$/))), months: Limit(36) })
const WdSearch = Schema.Struct({ name: Str(120) })
const WdFacts = Schema.Struct({ id: Str(15, /^Q\d+$/) })
const wikiTitle = (t: string) => enc(t.trim().replace(/ /g, "_"))
const ymd = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`
const claim = (claims: Record<string, unknown>, p: string) => arr(claims[p]).map(c => obj(obj(obj(c)["mainsnak"])["datavalue"])["value"])

// ---------------------------------------------------------------- SEC

const Cik = Schema.Struct({ cik: Str(10, /^\d{1,10}$/) })
const Revenue = Schema.Struct({ cik: Str(10, /^\d{1,10}$/), concept: Schema.optional(Schema.Literal("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet")) })
const SecLookup = Schema.Struct({ query: Str(80) })
const cik10 = (c: string) => c.padStart(10, "0")

export const PUBLIC_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  { id: "apps.apple.search", provider: "apple", platform: "app-stores", title: "App Store search", label: "SEEN", input: AppSearch, docs: "https://performance-partners.apple.com/search-api",
    description: "Apps matching a name or category in Apple's App Store for one country: developer, average rating, number of ratings, price, genre, release and last update dates.",
    subject: (i: typeof AppSearch.Type) => i.term.toLowerCase(),
    request: (i: typeof AppSearch.Type) => ({ method: "GET", url: "https://itunes.apple.com/search", query: { term: i.term, entity: "software", country: i.country ?? "us", limit: i.limit ?? 10 } }),
    parse: j => { const rows = arr(obj(j)["results"]).map(appRow); return rows.length ? ok({ label: "SEEN", apps: rows }, { country: "as asked", note: "Ratings are Apple's counts for that country's store." }) : none("No apps matched.") } },
  { id: "apps.apple.lookup", provider: "apple", platform: "app-stores", title: "App Store listing", label: "SEEN", input: AppLookup, docs: "https://performance-partners.apple.com/search-api",
    description: "One app's App Store listing by id or bundle id: rating, ratings count, price, version, release and last update dates, and the first lines of its description and release notes.",
    subject: (i: typeof AppLookup.Type) => i.id ?? i.bundleId ?? "app",
    request: (i: typeof AppLookup.Type) => ({ method: "GET", url: "https://itunes.apple.com/lookup", query: { ...(i.id ? { id: i.id } : { bundleId: i.bundleId }), country: i.country ?? "us" } }),
    parse: j => { const r = arr(obj(j)["results"])[0]; if (!r) return none("No such app in that store."); const a = obj(r)
      return ok({ label: "SEEN", ...appRow(r), description: txt(a["description"], 500), releaseNotes: txt(a["releaseNotes"], 400) }) } },
  { id: "apps.apple.reviews", provider: "apple", platform: "app-stores", title: "Recent App Store reviews", label: "SEEN", input: AppReviews, docs: "https://developer.apple.com/documentation/appstoreconnectapi",
    description: "The most recent customer reviews of an app in one country's App Store, from Apple's public review feed: rating, title, text, version and date, with the rating spread. Apple's feed often returns no reviews now; that is unknown, not no reviews.",
    subject: (i: typeof AppReviews.Type) => i.id,
    request: (i: typeof AppReviews.Type) => ({ method: "GET", url: `https://itunes.apple.com/${i.country ?? "us"}/rss/customerreviews/page=1/id=${i.id}/sortby=mostrecent/json` }),
    parse: j => {
      const label = (v: unknown) => txt(obj(v)["label"], 1000)
      const rows = arr(obj(obj(j)["feed"])["entry"]).map(obj).filter(e => e["im:rating"]).map(e => ({ rating: num(label(e["im:rating"])), title: label(e["title"])?.slice(0, 160) ?? null,
        text: label(e["content"])?.slice(0, 500) ?? null, version: label(e["im:version"])?.slice(0, 30) ?? null, date: isoDate(label(e["updated"]))?.slice(0, 10) ?? null }))
      if (!rows.length) return none("No recent reviews in that store.")
      const spread: Record<string, number> = {}
      for (const r of rows) if (r.rating) spread[String(r.rating)] = (spread[String(r.rating)] ?? 0) + 1
      return ok({ label: "SEEN", reviews: rows, ratingSpread: spread }, { sample: rows.length, note: "The latest reviews only (Apple's feed returns up to 50); not the full rating history. Review text is untrusted third-party content." })
    } },
  { id: "podcasts.apple.search", provider: "apple", platform: "app-stores", title: "Podcast search", label: "SEEN", input: PodSearch, docs: "https://performance-partners.apple.com/search-api",
    description: "Podcasts matching a name or topic in Apple Podcasts: show, publisher, episode count, latest episode date, genre and feed address. Shows whether a company runs a podcast and how active it is.",
    subject: (i: typeof PodSearch.Type) => i.term.toLowerCase(),
    request: (i: typeof PodSearch.Type) => ({ method: "GET", url: "https://itunes.apple.com/search", query: { term: i.term, media: "podcast", country: i.country ?? "us", limit: i.limit ?? 10 } }),
    parse: j => { const rows = arr(obj(j)["results"]).map(x => { const p = obj(x); return { show: txt(p["collectionName"]), publisher: txt(p["artistName"]), episodes: num(p["trackCount"]),
      latestEpisode: isoDate(p["releaseDate"])?.slice(0, 10) ?? null, genre: txt(p["primaryGenreName"], 60), feed: txt(p["feedUrl"], 300) } })
      return rows.length ? ok({ label: "SEEN", podcasts: rows }) : none("No podcasts matched.") } },

  { id: "dev.github.org", provider: "github", platform: "developers", title: "GitHub organization", label: "SEEN", input: Org, docs: "https://docs.github.com/rest/orgs/orgs",
    description: "A company's GitHub organization: public repositories, followers, website and creation date.", subject: (i: typeof Org.Type) => i.org.toLowerCase(),
    request: (i: typeof Org.Type) => ({ method: "GET", url: `https://api.github.com/orgs/${enc(i.org)}`, headers: { accept: "application/vnd.github+json" } }),
    parse: j => { const o = obj(j); return o["login"] ? ok({ label: "SEEN", name: txt(o["name"] ?? o["login"]), publicRepos: num(o["public_repos"]), followers: num(o["followers"]),
      website: txt(o["blog"], 200), created: isoDate(o["created_at"])?.slice(0, 10) ?? null, description: txt(o["description"]) }) : none("No such organization.") } },
  { id: "dev.github.repos", provider: "github", platform: "developers", title: "GitHub repositories of an organization", label: "SEEN", input: Org, docs: "https://docs.github.com/rest/repos/repos",
    description: "An organization's most recently updated public repositories with stars, forks, open issues, language and dates: open-source and developer-marketing activity.", subject: (i: typeof Org.Type) => i.org.toLowerCase(),
    request: (i: typeof Org.Type) => ({ method: "GET", url: `https://api.github.com/orgs/${enc(i.org)}/repos`, query: { sort: "pushed", per_page: 30 }, headers: { accept: "application/vnd.github+json" } }),
    parse: j => { const rows = arr(j).map(repoRow); return rows.length ? ok({ label: "SEEN", repositories: rows, totalStars: rows.reduce((s, r) => s + (r.stars ?? 0), 0) }, { note: "The 30 most recently pushed public repositories." }) : none("No public repositories.") } },
  { id: "dev.github.repo", provider: "github", platform: "developers", title: "GitHub repository", label: "SEEN", input: Repo, docs: "https://docs.github.com/rest/repos/repos",
    description: "One public repository: stars, watchers, forks, open issues, license, creation and last push dates.", subject: (i: typeof Repo.Type) => `${i.owner}/${i.repo}`.toLowerCase(),
    request: (i: typeof Repo.Type) => ({ method: "GET", url: `https://api.github.com/repos/${enc(i.owner)}/${enc(i.repo)}`, headers: { accept: "application/vnd.github+json" } }),
    parse: j => { const r = obj(j); return r["full_name"] ? ok({ label: "SEEN", ...repoRow(j), watchers: num(r["subscribers_count"]), license: txt(obj(r["license"])["spdx_id"], 40) }) : none("No such repository.") } },
  { id: "dev.github.releases", provider: "github", platform: "developers", title: "GitHub releases", label: "SEEN", input: Repo, docs: "https://docs.github.com/rest/releases/releases",
    description: "A repository's recent releases with dates: product shipping cadence.", subject: (i: typeof Repo.Type) => `${i.owner}/${i.repo}`.toLowerCase(),
    request: (i: typeof Repo.Type) => ({ method: "GET", url: `https://api.github.com/repos/${enc(i.owner)}/${enc(i.repo)}/releases`, query: { per_page: 30 }, headers: { accept: "application/vnd.github+json" } }),
    parse: j => { const rows = arr(j).map(x => { const r = obj(x); return { tag: txt(r["tag_name"], 60), name: txt(r["name"], 140), published: isoDate(r["published_at"])?.slice(0, 10) ?? null, prerelease: r["prerelease"] === true } }).filter(r => r.published)
      const byMonth: Record<string, number> = {}
      for (const r of rows) byMonth[monthKey(r.published!)] = (byMonth[monthKey(r.published!)] ?? 0) + 1
      return rows.length ? ok({ label: "SEEN", releases: rows, releasesByMonth: byMonth, timeline: rows.slice(0, 15).map(r => ({ date: `${r.published}T00:00:00.000Z`, event: `Release ${r.tag}${r.name ? `: ${r.name}` : ""}`, label: "SEEN" })) }) : none("No releases published.") } },
  { id: "dev.github.search", provider: "github", platform: "developers", title: "GitHub repository search", label: "SEEN", input: RepoSearch, docs: "https://docs.github.com/rest/search/search",
    description: "Public repositories matching a query (for example a product name or category), most starred first, with the total count.", subject: (i: typeof RepoSearch.Type) => i.query.toLowerCase(),
    request: (i: typeof RepoSearch.Type) => ({ method: "GET", url: "https://api.github.com/search/repositories", query: { q: i.query, sort: "stars", per_page: i.limit ?? 15 }, headers: { accept: "application/vnd.github+json" } }),
    parse: j => { const o = obj(j), rows = arr(o["items"]).map(repoRow); return rows.length ? ok({ label: "SEEN", total: num(o["total_count"]), repositories: rows }) : none("No repositories matched.") } },

  { id: "dev.npm.downloads", provider: "npm", platform: "developers", title: "npm downloads by month (last year)", label: "SEEN", input: Pkg, docs: "https://github.com/npm/registry/blob/main/docs/download-counts.md",
    description: "Monthly download counts of an npm package over the last year: developer adoption over time.", subject: (i: typeof Pkg.Type) => i.package.toLowerCase(),
    request: (i: typeof Pkg.Type) => ({ method: "GET", url: `https://api.npmjs.org/downloads/range/last-year/${i.package.split("/").map(enc).join("/")}` }),
    parse: j => { const days = arr(obj(j)["downloads"]).map(obj); if (!days.length) return none("No download data for this package.")
      const m = new Map<string, number>(); for (const d of days) { const day = txt(d["day"], 10); if (day) m.set(day.slice(0, 7), (m.get(day.slice(0, 7)) ?? 0) + (num(d["downloads"]) ?? 0)) }
      const months = [...m.entries()].map(([month, downloads]) => ({ month, downloads }))
      return ok({ label: "SEEN", months, total: months.reduce((s, x) => s + x.downloads, 0) }, { note: "Downloads include automated builds and mirrors; they track adoption, not users." }) } },
  { id: "dev.npm.package", provider: "npm", platform: "developers", title: "npm package", label: "SEEN", input: Pkg, docs: "https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md",
    description: "An npm package's latest version, description, homepage and license.", subject: (i: typeof Pkg.Type) => i.package.toLowerCase(),
    request: (i: typeof Pkg.Type) => ({ method: "GET", url: `https://registry.npmjs.org/${i.package.split("/").map(enc).join("/")}/latest` }),
    parse: j => { const p = obj(j); return p["name"] ? ok({ label: "SEEN", name: txt(p["name"]), version: txt(p["version"], 40), description: txt(p["description"]), homepage: txt(p["homepage"], 300), license: txt(p["license"], 40) }) : none("No such package.") } },
  { id: "dev.pypi.downloads", provider: "pypi", platform: "developers", title: "PyPI downloads (recent)", label: "SEEN", input: Pkg, docs: "https://pypistats.org/api/",
    description: "A Python package's downloads in the last day, week and month.", subject: (i: typeof Pkg.Type) => i.package.toLowerCase(),
    request: (i: typeof Pkg.Type) => ({ method: "GET", url: `https://pypistats.org/api/packages/${enc(i.package.toLowerCase())}/recent` }),
    parse: j => { const d = obj(obj(j)["data"]); return Object.keys(d).length ? ok({ label: "SEEN", lastDay: num(d["last_day"]), lastWeek: num(d["last_week"]), lastMonth: num(d["last_month"]) }, { note: "Installs, including automated ones; not users." }) : none("No download data.") } },
  { id: "dev.pypi.package", provider: "pypi", platform: "developers", title: "PyPI package", label: "SEEN", input: Pkg, docs: "https://warehouse.pypa.io/api-reference/json.html",
    description: "A Python package's latest version, summary, project links, number of releases and latest upload date.", subject: (i: typeof Pkg.Type) => i.package.toLowerCase(),
    request: (i: typeof Pkg.Type) => ({ method: "GET", url: `https://pypi.org/pypi/${enc(i.package)}/json` }),
    parse: j => { const o = obj(j), info = obj(o["info"]); if (!info["name"]) return none("No such package.")
      return ok({ label: "SEEN", name: txt(info["name"]), version: txt(info["version"], 40), summary: txt(info["summary"]), links: obj(info["project_urls"]), releases: Object.keys(obj(o["releases"])).length,
        latestUpload: isoDate(obj(arr(o["urls"])[0])["upload_time_iso_8601"])?.slice(0, 10) ?? null }) } },
  { id: "dev.dockerhub.repo", provider: "dockerhub", platform: "developers", title: "Docker Hub repository", label: "SEEN", input: Docker, docs: "https://docs.docker.com/docker-hub/api/latest/",
    description: "A Docker Hub repository's pull count, stars, last update and description.", subject: (i: typeof Docker.Type) => `${i.namespace}/${i.repository}`,
    request: (i: typeof Docker.Type) => ({ method: "GET", url: `https://hub.docker.com/v2/repositories/${enc(i.namespace)}/${enc(i.repository)}/` }),
    parse: j => { const r = obj(j); return r["name"] ? ok({ label: "SEEN", pulls: num(r["pull_count"]), stars: num(r["star_count"]), updated: isoDate(r["last_updated"])?.slice(0, 10) ?? null, description: txt(r["description"]) }, { note: "Pulls include automated pulls." }) : none("No such repository.") } },

  { id: "wiki.summary", provider: "wikimedia", platform: "reference", title: "Wikipedia summary", label: "SEEN", input: Title, docs: "https://en.wikipedia.org/api/rest_v1/",
    description: "The Wikipedia article summary for a company, product or topic: description, first paragraph and last edit.", subject: (i: typeof Title.Type) => i.title.toLowerCase(),
    request: (i: typeof Title.Type) => ({ method: "GET", url: `https://${i.lang ?? "en"}.wikipedia.org/api/rest_v1/page/summary/${wikiTitle(i.title)}` }),
    parse: j => { const o = obj(j); return o["title"] ? ok({ label: "SEEN", title: txt(o["title"]), description: txt(o["description"]), extract: txt(o["extract"], 600), url: txt(obj(obj(o["content_urls"])["desktop"])["page"], 300), lastEdited: isoDate(o["timestamp"])?.slice(0, 10) ?? null }) : none("No Wikipedia article.") } },
  { id: "wiki.pageviews", provider: "wikimedia", platform: "reference", title: "Wikipedia pageviews by month", label: "SEEN", input: Views, docs: "https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html",
    description: "Monthly views of a Wikipedia article (people, not bots) for up to three years: measured public interest in a company, product or category over time.", subject: (i: typeof Views.Type) => i.title.toLowerCase(),
    request: (i: typeof Views.Type, now: Date) => {
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86_400_000), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (i.months ?? 24), 1))
      return { method: "GET", url: `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${i.lang ?? "en"}.wikipedia/all-access/user/${wikiTitle(i.title)}/monthly/${ymd(start)}/${ymd(end)}` }
    },
    parse: j => { const rows = arr(obj(j)["items"]).map(obj).map(x => ({ month: `${String(x["timestamp"] ?? "").slice(0, 4)}-${String(x["timestamp"] ?? "").slice(4, 6)}`, views: num(x["views"]) })).filter(r => r.views !== null)
      return rows.length ? ok({ label: "SEEN", months: rows }, { note: "Measured by Wikimedia: views of the article by people. It shows interest in the subject, not visits to the company's site or customers." }) : none("No pageview data for that title.") } },
  { id: "wiki.wikidata.search", provider: "wikimedia", platform: "reference", title: "Find a company in Wikidata", label: "SEEN", input: WdSearch, docs: "https://www.wikidata.org/w/api.php",
    description: "Wikidata entities matching a name, with ids and descriptions, to look up structured facts.", subject: (i: typeof WdSearch.Type) => i.name.toLowerCase(),
    request: (i: typeof WdSearch.Type) => ({ method: "GET", url: "https://www.wikidata.org/w/api.php", query: { action: "wbsearchentities", search: i.name, language: "en", format: "json", limit: 7 } }),
    parse: j => { const rows = arr(obj(j)["search"]).map(x => { const e = obj(x); return { id: txt(e["id"], 15), label: txt(e["label"]), description: txt(e["description"]) } }); return rows.length ? ok({ label: "SEEN", entities: rows }) : none("No match.") } },
  { id: "wiki.wikidata.facts", provider: "wikimedia", platform: "reference", title: "Company facts from Wikidata", label: "SEEN", input: WdFacts, docs: "https://www.wikidata.org/wiki/Wikidata:Data_access",
    description: "Structured facts for a Wikidata entity: founding date, employees, revenue, official website, headquarters, industry and founders (as Wikidata ids), with the English description.", subject: (i: typeof WdFacts.Type) => i.id,
    request: (i: typeof WdFacts.Type) => ({ method: "GET", url: "https://www.wikidata.org/w/api.php", query: { action: "wbgetentities", ids: i.id, props: "claims|labels|descriptions", languages: "en", format: "json" } }),
    parse: (j, i: typeof WdFacts.Type) => { const e = obj(obj(obj(j)["entities"])[i.id]); const c = obj(e["claims"]); if (!Object.keys(c).length) return none("No facts for that id.")
      const amount = (p: string) => claim(c, p).map(v => ({ amount: num(obj(v)["amount"]), unit: txt(obj(v)["unit"], 80) })).filter(x => x.amount !== null)
      const ids = (p: string) => claim(c, p).map(v => txt(obj(v)["id"], 15)).filter(Boolean)
      return ok({ label: "SEEN", name: txt(obj(obj(e["labels"])["en"])["value"]), description: txt(obj(obj(e["descriptions"])["en"])["value"]),
        founded: txt(obj(claim(c, "P571")[0])["time"], 30), website: claim(c, "P856").map(v => txt(v, 200)).filter(Boolean), employees: amount("P1128"), revenue: amount("P2139"),
        headquarters: ids("P159"), industry: ids("P452"), founders: ids("P112") }, { note: "Community-edited facts; check dates and sources before relying on them." }) } },

  { id: "finance.sec.lookup", provider: "sec", platform: "public-companies", title: "Find a public company's SEC id", label: "SEEN", input: SecLookup, docs: "https://www.sec.gov/os/accessing-edgar-data",
    description: "Matches a company name or ticker to its SEC CIK number, for filings and reported revenue.", subject: (i: typeof SecLookup.Type) => i.query.toLowerCase(),
    request: () => ({ method: "GET", url: "https://www.sec.gov/files/company_tickers.json" }),
    parse: (j, i: typeof SecLookup.Type) => { const q = i.query.trim().toLowerCase()
      const rows = Object.values(obj(j)).map(obj).map(x => ({ cik: String(num(x["cik_str"]) ?? ""), ticker: txt(x["ticker"], 12), name: txt(x["title"], 160) }))
        .filter(x => x.ticker?.toLowerCase() === q || x.name?.toLowerCase().includes(q))
        // An exact ticker first, then names that start with the query, then the rest.
        .sort((a, b) => rank(a) - rank(b)).slice(0, 10)
      function rank(x: { ticker: string | null; name: string | null }) { return x.ticker?.toLowerCase() === q ? 0 : x.name?.toLowerCase().startsWith(q) ? 1 : 2 }
      return rows.length ? ok({ label: "SEEN", companies: rows }) : none("No U.S. public company matched; private companies do not file with the SEC.") } },
  { id: "finance.sec.filings", provider: "sec", platform: "public-companies", title: "SEC filings", label: "SEEN", input: Cik, docs: "https://www.sec.gov/edgar/sec-api-documentation",
    description: "A public company's recent SEC filings (annual and quarterly reports, current reports) with dates, plus its industry code and tickers.", subject: (i: typeof Cik.Type) => `cik ${Number(i.cik)}`,
    request: (i: typeof Cik.Type) => ({ method: "GET", url: `https://data.sec.gov/submissions/CIK${cik10(i.cik)}.json` }),
    parse: j => { const o = obj(j), r = obj(obj(o["filings"])["recent"]); const forms = arr(r["form"]), dates = arr(r["filingDate"]), docs = arr(r["primaryDocument"]), acc = arr(r["accessionNumber"])
      const rows = forms.slice(0, 40).map((f, k) => ({ form: txt(f, 20), filed: txt(dates[k], 10), document: txt(docs[k], 120), accession: txt(acc[k], 30) })).filter(x => x.form && /^(10-K|10-Q|8-K|S-1|20-F|6-K|DEF 14A)/.test(x.form))
      return o["name"] ? ok({ label: "SEEN", name: txt(o["name"]), tickers: arr(o["tickers"]).map(t => txt(t, 12)), industry: txt(o["sicDescription"], 120), filings: rows,
        timeline: rows.filter(x => x.form === "10-K" || x.form === "8-K").slice(0, 10).map(x => ({ date: `${x.filed}T00:00:00.000Z`, event: `SEC ${x.form} filed`, label: "SEEN" })) }) : none("No filings.") } },
  { id: "finance.sec.revenue", provider: "sec", platform: "public-companies", title: "Reported revenue (SEC)", label: "SEEN", input: Revenue, docs: "https://www.sec.gov/edgar/sec-api-documentation",
    description: "A public company's revenue as reported in its annual reports, by fiscal year: measured company growth. Companies report under different concepts; if Revenues has gaps, try RevenueFromContractWithCustomerExcludingAssessedTax.", subject: (i: typeof Revenue.Type) => `cik ${Number(i.cik)} ${i.concept ?? "Revenues"}`,
    request: (i: typeof Revenue.Type) => ({ method: "GET", url: `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik10(i.cik)}/us-gaap/${i.concept ?? "Revenues"}.json` }),
    parse: j => { const usd = arr(obj(obj(j)["units"])["USD"]).map(obj).filter(x => x["form"] === "10-K" && x["fp"] === "FY")
      const byYear = new Map<string, number>(); for (const x of usd) { const fy = String(x["fy"] ?? ""); const v = num(x["val"]); if (fy && v !== null && !byYear.has(fy)) byYear.set(fy, v) }
      const years = [...byYear.entries()].sort().map(([year, revenue]) => ({ year, revenueUsd: revenue }))
      return years.length ? ok({ label: "SEEN", years }, { note: "As reported under the us-gaap Revenues concept in annual reports. Some companies report under a different revenue concept; missing here is unknown, not zero." }) : none("No annual revenue reported under this concept.") } },
]
