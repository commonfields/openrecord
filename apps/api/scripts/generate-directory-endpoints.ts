// Generates read-only research endpoints for many providers at once from
// their published OpenAPI / Swagger descriptions, collected in the public
// domain (CC0) OpenAPI directory: https://github.com/APIs-guru/openapi-directory
//
//   pnpm --filter @openrecord/api exec tsx scripts/generate-directory-endpoints.ts <directory checkout>/APIs
//
// Each source below names one provider's spec files and how a business
// connects its own credential. From each spec only GET operations are kept;
// operations about credentials, tokens, sign-in or webhooks are dropped.
// Servers, auth and parameters come from the spec unless the source overrides
// them (a spec's server or auth scheme is sometimes wrong for the live API).
// Output: src/research/endpoints/generated/directory.json, loaded by
// generated.ts and providers.ts. Run again to refresh.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

type Auth =
  | { kind: "none" }
  | { kind: "api_key"; in: "query" | "header"; name: string; prefix?: string; optional?: boolean }
  | { kind: "api_key_pair"; in: "query"; names: [string, string] }
  | { kind: "bearer"; optional?: boolean }
  | { kind: "basic" }
  | { kind: "client_credentials"; tokenUrl: string }

interface Source {
  /** Spec files relative to the directory's APIs folder (a folder means every spec inside it). */
  readonly specs: ReadonlyArray<string>
  readonly provider: string
  readonly name: string
  readonly platform: string
  readonly prefix: string
  readonly docs: string
  readonly note: string
  /** How the business gets a credential, where, and an example. Omitted for providers that need none. */
  readonly connect?: { readonly how: string; readonly url: string; readonly example: string }
  readonly auth?: Auth
  /** Replaces the spec's server (for example a wrong host in the published description). */
  readonly base?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly skip?: RegExp
  readonly paid?: boolean
}

const KEY = (how: string, url: string, example = "...") => ({ how, url, example })
const SOURCES: ReadonlyArray<Source> = [
  // ---------------------------------------------------------------- CRM, email, sales
  { specs: ["hubapi.com"], provider: "hubspot", name: "HubSpot", platform: "crm", prefix: "crm.hubspot", docs: "https://developers.hubspot.com/docs/api/overview",
    auth: { kind: "bearer" }, connect: KEY("In HubSpot, Settings, Integrations, Private apps, create an app with read-only CRM scopes and paste its access token.", "https://app.hubspot.com/private-apps", "pat-na1-..."),
    note: "The business's own HubSpot CRM through a private app token with read scopes. Contacts, companies and deals as HubSpot holds them; not proof of attribution." },
  { specs: ["sendgrid.com"], provider: "sendgrid", name: "SendGrid", platform: "email", prefix: "email.sendgrid", docs: "https://www.twilio.com/docs/sendgrid/api-reference",
    auth: { kind: "bearer" }, base: "https://api.sendgrid.com/v3", connect: KEY("In SendGrid, Settings, API Keys, create a key with read-only access and paste it.", "https://app.sendgrid.com/settings/api_keys", "SG...."),
    note: "The business's own SendGrid account: email statistics, lists and templates. Opens and clicks are as SendGrid counts them (privacy features inflate or hide opens)." },
  { specs: ["salesloft.com"], provider: "salesloft", name: "Salesloft", platform: "crm", prefix: "crm.salesloft", docs: "https://developers.salesloft.com/docs/api",
    auth: { kind: "bearer" }, connect: KEY("In Salesloft, Settings, API, create an API key and paste it.", "https://accounts.salesloft.com/oauth/applications", "v2_ak_..."),
    note: "The business's own Salesloft account: people, cadences and activity, read-only." },
  { specs: ["pendo.io"], provider: "pendo", name: "Pendo", platform: "product", prefix: "product.pendo", docs: "https://engageapi.pendo.io/",
    auth: { kind: "api_key", in: "header", name: "x-pendo-integration-key" }, base: "https://app.pendo.io/api/v1",
    connect: KEY("In Pendo, Settings, Integrations, Integration Keys, create a read-only key and paste it.", "https://app.pendo.io/admin/integrationkeys"),
    note: "The business's own Pendo product analytics and feedback, read-only." },
  // ---------------------------------------------------------------- social, video, audio, community
  { specs: ["twitter.com/current"], provider: "x_api", name: "X (Twitter) API", platform: "social", prefix: "social.x", docs: "https://docs.x.com/x-api",
    auth: { kind: "bearer" }, connect: KEY("In the X developer portal, open your project's app, Keys and tokens, and paste the app's Bearer Token.", "https://developer.x.com/en/portal/dashboard", "AAAA..."),
    note: "X's official API v2 on the business's own developer app. Read volumes depend on the app's access tier; a missing post may be a tier limit, not absence.", paid: true },
  { specs: ["mastodon.local"], provider: "mastodon", name: "Mastodon (mastodon.social)", platform: "social", prefix: "social.mastodon", docs: "https://docs.joinmastodon.org/api/",
    auth: { kind: "bearer", optional: true }, base: "https://mastodon.social", skip: /\/(admin|filters|lists|markers|notifications|push|conversations|domain_blocks|follow_requests|mutes|blocks|bookmarks|favourites|preferences|reports|scheduled_statuses|suggestions|apps|accounts\/verify_credentials|announcements|endorsements)(\/|$)/,
    connect: KEY("Optional: in Mastodon, Preferences, Development, create an application with read scopes and paste its access token.", "https://mastodon.social/settings/applications"),
    note: "Public posts, accounts, tags and trends on the mastodon.social server. Other servers federate partially; not seen here is not absence." },
  { specs: ["vimeo.com"], provider: "vimeo", name: "Vimeo", platform: "video", prefix: "video.vimeo", docs: "https://developer.vimeo.com/api/reference",
    auth: { kind: "bearer" }, connect: KEY("In Vimeo's developer site, create an app, generate a personal access token with public and private read scopes, and paste it.", "https://developer.vimeo.com/apps"),
    note: "Vimeo's official API: videos, channels and statistics the token can see." },
  { specs: ["soundcloud.com"], provider: "soundcloud", name: "SoundCloud", platform: "audio", prefix: "audio.soundcloud", docs: "https://developers.soundcloud.com/docs/api/explorer/open-api",
    auth: { kind: "api_key", in: "header", name: "authorization", prefix: "OAuth " }, skip: /^\/connect$|^\/me(\/|$)/, connect: KEY("Register an app with SoundCloud and paste an access token for it.", "https://soundcloud.com/you/apps"),
    note: "SoundCloud's official API: tracks, playlists and public user data." },
  { specs: ["spotify.com/1.0.0"], provider: "spotify", name: "Spotify", platform: "audio", prefix: "audio.spotify", docs: "https://developer.spotify.com/documentation/web-api",
    auth: { kind: "client_credentials", tokenUrl: "https://accounts.spotify.com/api/token" }, skip: /^\/me(\/|$)/,
    connect: KEY("In the Spotify developer dashboard, create an app and paste client_id:client_secret.", "https://developer.spotify.com/dashboard", "abc123:def456..."),
    note: "Spotify's public catalog (artists, shows, episodes, playlists) under the business's own app. Follower counts as Spotify reports them." },
  { specs: ["dev.to/1.0.0"], provider: "devto", name: "DEV Community", platform: "community", prefix: "community.devto", docs: "https://developers.forem.com/api/v1",
    auth: { kind: "api_key", in: "header", name: "api-key", optional: true }, headers: { accept: "application/vnd.forem.api-v1+json" },
    connect: KEY("Optional: in DEV, Settings, Extensions, generate an API key and paste it.", "https://dev.to/settings/extensions"),
    note: "Public articles, comments, tags and organizations on DEV. Reactions and views are as DEV reports them." },
  { specs: ["stackexchange.com"], provider: "stackexchange", name: "Stack Exchange", platform: "community", prefix: "community.stackexchange", docs: "https://api.stackexchange.com/docs",
    auth: { kind: "api_key", in: "query", name: "key", optional: true }, skip: /\/(me|access-tokens|apps|inbox|notifications)(\/|$)|\/write-permissions/,
    connect: KEY("Optional: register an app on Stack Apps and paste its key, for a higher daily quota.", "https://stackapps.com/apps/oauth/register"),
    note: "Public questions, answers, tags and users on Stack Overflow and other Stack Exchange sites (pass site, for example stackoverflow). Without a key the quota is 300 requests a day per server." },
  { specs: ["listennotes.com"], provider: "listennotes", name: "Listen Notes", platform: "podcasts", prefix: "podcasts.listennotes", docs: "https://www.listennotes.com/api/docs/",
    auth: { kind: "api_key", in: "header", name: "x-listenapi-key" }, connect: KEY("Create a Listen Notes API account and paste the API key.", "https://www.listennotes.com/api/dashboard/"),
    note: "Podcast search and metadata from Listen Notes' index: who discusses a brand or category on podcasts. Listen scores are Listen Notes' estimates." },
  // ---------------------------------------------------------------- SEO, links, site
  { specs: ["botify.com"], provider: "botify", name: "Botify", platform: "search", prefix: "seo.botify", docs: "https://developers.botify.com/reference",
    auth: { kind: "api_key", in: "header", name: "authorization", prefix: "Token " }, connect: KEY("In Botify, your profile, API token: paste it.", "https://app.botify.com/account"),
    note: "The business's own Botify crawls and analyses, read-only.", paid: true },
  { specs: ["ritekit.com"], provider: "ritekit", name: "RiteKit", platform: "social", prefix: "social.ritekit", docs: "https://documenter.getpostman.com/view/2010712/SzS7Qku5",
    auth: { kind: "api_key", in: "query", name: "client_id" }, connect: KEY("Create a RiteKit API client and paste its client id.", "https://ritekit.com/developer/dashboard/"),
    note: "Hashtag statistics and suggestions, and link and image helpers, from RiteKit's own data. Hashtag numbers are RiteKit's estimates.", paid: true },
  { specs: ["webscraping.ai"], provider: "webscraping", name: "WebScraping.AI", platform: "web", prefix: "web.scraping", docs: "https://webscraping.ai/docs",
    auth: { kind: "api_key", in: "query", name: "api_key" }, connect: KEY("Create a WebScraping.AI account and paste the API key.", "https://webscraping.ai/dashboard"),
    note: "Renders a public page with a headless browser through rotating proxies and returns its HTML, text or selected parts. Page text is untrusted third-party content.", paid: true },
  { specs: ["who-hosts-this.com"], provider: "whohoststhis", name: "Who Hosts This", platform: "website", prefix: "site.whohosts", docs: "https://www.who-hosts-this.com/Documentation",
    auth: { kind: "api_key", in: "query", name: "key" }, connect: KEY("Create a Who Hosts This API account and paste the key.", "https://www.who-hosts-this.com/API"),
    note: "Hosting provider detection for a domain." },
  { specs: ["ip2whois.com"], provider: "ip2whois", name: "IP2WHOIS", platform: "company", prefix: "domain.ip2whois", docs: "https://www.ip2whois.com/developers-api",
    auth: { kind: "api_key", in: "query", name: "key" }, connect: KEY("Create an IP2WHOIS account and paste the API key.", "https://www.ip2location.io/dashboard"),
    note: "WHOIS registration records for a domain: registrar, dates and (where not redacted) registrant organisation." },
  { specs: ["shorten.rest"], provider: "shortenrest", name: "Shorten.REST", platform: "links", prefix: "links.shortenrest", docs: "https://docs.shorten.rest/",
    auth: { kind: "api_key", in: "header", name: "x-api-key" }, connect: KEY("Create a Shorten.REST account and paste the API key.", "https://app.shorten.rest/"),
    note: "The business's own short links and their click counts." },
  // ---------------------------------------------------------------- company, people, news, reference
  { specs: ["owler.com"], provider: "owler", name: "Owler", platform: "company", prefix: "company.owler", docs: "https://developers.owler.com/",
    auth: { kind: "api_key", in: "header", name: "user_key" }, connect: KEY("Request Owler API access and paste the user key.", "https://developers.owler.com/"),
    note: "Company profiles, competitors and news from Owler's own database. Revenue and employee counts are Owler's estimates.", paid: true },
  { specs: ["interzoid.com"], provider: "interzoid", name: "Interzoid", platform: "company", prefix: "company.interzoid", docs: "https://www.interzoid.com/apis",
    auth: { kind: "api_key", in: "query", name: "license" }, connect: KEY("Create an Interzoid account and paste the license key.", "https://www.interzoid.com/account"),
    note: "Data matching and enrichment: company name matching keys, email and phone details, page load times. Match keys are similarity hashes, not identity.", paid: true },
  { specs: ["namsor.com"], provider: "namsor", name: "NamSor", platform: "people", prefix: "people.namsor", docs: "https://v2.namsor.com/NamSorAPIv2/apidoc.html",
    auth: { kind: "api_key", in: "header", name: "x-api-key" }, connect: KEY("Create a NamSor account and paste the API key.", "https://namsor.app/my-account/"),
    note: "Statistical inferences from personal names (likely origin, gender). INFERRED and never a fact about a person; use only for aggregate audience questions.", paid: true },
  { specs: ["nytimes.com"], provider: "nytimes", name: "The New York Times", platform: "news", prefix: "news.nytimes", docs: "https://developer.nytimes.com/apis",
    auth: { kind: "api_key", in: "query", name: "api-key" }, connect: KEY("Create a New York Times developer app and paste its API key.", "https://developer.nytimes.com/my-apps"),
    note: "New York Times article search, most popular and top stories: press coverage of a brand or category. Links and abstracts only; not the article text." },
  { specs: ["archive.org"], provider: "archive_api", name: "Internet Archive (API)", platform: "history", prefix: "history.archive_api", docs: "https://archive.org/developers/",
    note: "The Internet Archive's public APIs: archived page availability and collection search. A missing capture does not mean the page did not exist." },
  { specs: ["opencagedata.com"], provider: "opencage", name: "OpenCage", platform: "local", prefix: "local.opencage", docs: "https://opencagedata.com/api",
    auth: { kind: "api_key", in: "query", name: "key" }, connect: KEY("Create an OpenCage account and paste the API key.", "https://opencagedata.com/dashboard"),
    note: "Forward and reverse geocoding from open data: addresses to places and back, for local presence questions." },
  { specs: ["tomtom.com/search"], provider: "tomtom", name: "TomTom", platform: "local", prefix: "local.tomtom", docs: "https://developer.tomtom.com/search-api/documentation/product-information/introduction",
    auth: { kind: "api_key", in: "query", name: "key" }, connect: KEY("Create a TomTom developer app and paste its API key.", "https://developer.tomtom.com/user/me/apps"),
    note: "TomTom's places search: businesses and points of interest near a location, as TomTom lists them (a listing source many in-car and map products use)." },
  { specs: ["ean-search.org"], provider: "eansearch", name: "EAN-Search", platform: "commerce", prefix: "commerce.eansearch", docs: "https://www.ean-search.org/ean-database-api.html",
    auth: { kind: "api_key", in: "query", name: "token" }, connect: KEY("Create an EAN-Search API account and paste the token.", "https://www.ean-search.org/ean-database-api.html"),
    note: "Product lookup by barcode (EAN/UPC/ISBN) and name in EAN-Search's database." },
  { specs: ["go-upc.com"], provider: "goupc", name: "Go-UPC", platform: "commerce", prefix: "commerce.goupc", docs: "https://go-upc.com/api",
    auth: { kind: "api_key", in: "query", name: "key" }, connect: KEY("Create a Go-UPC account and paste the API key.", "https://go-upc.com/plans/api"),
    note: "Product details by barcode from Go-UPC's database." },
  { specs: ["wordassociations.net"], provider: "wordassociations", name: "Word Associations", platform: "content", prefix: "content.wordassociations", docs: "https://wordassociations.net/en/api",
    auth: { kind: "api_key", in: "query", name: "apikey" }, connect: KEY("Create a Word Associations API account and paste the key.", "https://wordassociations.net/en/api"),
    note: "Words people associate with a term (from text corpora): vocabulary for content and positioning. Not a survey of buyers." },
  // ---------------------------------------------------------------- commerce
  { specs: ["squareup.com"], provider: "square", name: "Square", platform: "revenue", prefix: "revenue.square", docs: "https://developer.squareup.com/reference/square",
    auth: { kind: "bearer" }, skip: /^\/v1\/|\/(oauth2|mobile|apple-pay|webhooks|cards)(\/|$)/,
    connect: KEY("In the Square developer dashboard, open your app, Credentials, and paste the production access token.", "https://developer.squareup.com/apps", "EAAA..."),
    note: "The business's own Square sales, orders, customers, catalog and locations, read-only. Sales are recorded transactions, not their cause." },
  { specs: ["ebay.com/buy-browse", "ebay.com/commerce-taxonomy", "ebay.com/commerce-catalog", "ebay.com/buy-marketing", "ebay.com/buy-deal", "ebay.com/commerce-charity"], provider: "ebay", name: "eBay", platform: "commerce", prefix: "commerce.ebay", docs: "https://developer.ebay.com/develop/apis",
    auth: { kind: "bearer" }, connect: KEY("In the eBay developer program, create a production keyset and paste an application access token (client credentials grant).", "https://developer.ebay.com/my/keys", "v^1.1#i^1#..."),
    note: "eBay's public marketplace: item listings, prices, categories and deals, as eBay returns them for the app." },
  // ---------------------------------------------------------------- media
  { specs: ["giphy.com"], provider: "giphy", name: "GIPHY", platform: "social", prefix: "social.giphy", docs: "https://developers.giphy.com/docs/api/",
    auth: { kind: "api_key", in: "query", name: "api_key" }, connect: KEY("Create a GIPHY developer app and paste its API key.", "https://developers.giphy.com/dashboard/"),
    note: "GIF and sticker search and trends: a brand's or category's presence in GIPHY's library." },
  { specs: ["shutterstock.com"], provider: "shutterstock", name: "Shutterstock", platform: "content", prefix: "content.shutterstock", docs: "https://api-reference.shutterstock.com/",
    auth: { kind: "bearer" }, base: "https://api.shutterstock.com", skip: /\/(user|oauth|subscriptions|licenses|downloads)(\/|$)/,
    connect: KEY("In Shutterstock's developer portal, create an app and paste an access token.", "https://www.shutterstock.com/account/developers/apps"),
    note: "Stock image, video and audio search and metadata. Searching does not license anything." },
  { specs: ["flickr.com"], provider: "flickr", name: "Flickr", platform: "social", prefix: "social.flickr", docs: "https://www.flickr.com/services/api/",
    auth: { kind: "api_key", in: "query", name: "api_key" }, connect: KEY("Create a Flickr app and paste its key.", "https://www.flickr.com/services/apps/create/"),
    note: "Public photos, groups and tags on Flickr." },
  // ---------------------------------------------------------------- work and publishing tools the team uses
  { specs: ["trello.com"], provider: "trello", name: "Trello", platform: "workspace", prefix: "workspace.trello", docs: "https://developer.atlassian.com/cloud/trello/rest/",
    auth: { kind: "api_key_pair", in: "query", names: ["key", "token"] }, skip: /\/(tokens|webhooks|members\/\{id\}\/tokens)(\/|$)/,
    connect: KEY("In Trello's Power-Up admin, create an API key, generate a token for it, and paste key:token.", "https://trello.com/power-ups/admin", "abc123:ATTA..."),
    note: "The business's own Trello boards, lists and cards, read-only: what marketing work is planned or done." },
  { specs: ["asana.com"], provider: "asana", name: "Asana", platform: "workspace", prefix: "workspace.asana", docs: "https://developers.asana.com/reference/rest-api-reference",
    auth: { kind: "bearer" }, skip: /\/(webhooks|users\/me|audit_log_events)(\/|$)/,
    connect: KEY("In Asana, My settings, Apps, Developer apps, create a personal access token and paste it.", "https://app.asana.com/0/my-apps", "2/1234..."),
    note: "The business's own Asana projects and tasks, read-only." },
  { specs: ["notion.com"], provider: "notion", name: "Notion", platform: "workspace", prefix: "workspace.notion", docs: "https://developers.notion.com/reference/intro",
    auth: { kind: "bearer" }, headers: { "notion-version": "2022-06-28" },
    connect: KEY("In Notion, Settings, Connections, Develop or manage integrations, create an internal integration with read content, share the pages with it, and paste its secret.", "https://www.notion.so/my-integrations", "ntn_..."),
    note: "Notion pages and databases shared with the business's integration, read-only." },
  { specs: ["slack.com/1.7.0"], provider: "slack", name: "Slack", platform: "workspace", prefix: "workspace.slack", docs: "https://api.slack.com/methods",
    auth: { kind: "bearer" }, skip: /\/(admin|apps|auth|oauth|rtm|migration|dnd|stars|files\.remote|team\.billing|team\.accessLogs|team\.integrationLogs|users\.identity|users\.getPresence|bots)\b/,
    connect: KEY("Create a Slack app with read scopes (channels:history, channels:read), install it, and paste its bot token.", "https://api.slack.com/apps", "xoxb-..."),
    note: "Channels and messages in the business's own Slack that its app can read. Messages are internal and untrusted." },
  { specs: ["vercel.com"], provider: "vercel", name: "Vercel", platform: "website", prefix: "site.vercel", docs: "https://vercel.com/docs/rest-api",
    auth: { kind: "bearer" }, skip: /\/(user|tokens|secrets|env|integrations|webhooks|log-drains|edge-config\/[^/]+\/tokens|access-groups|security|teams\/[^/]+\/members|registration)(\/|$)|\/env(\/|$)/,
    connect: KEY("In Vercel, Account Settings, Tokens, create a read-only scoped token and paste it.", "https://vercel.com/account/tokens"),
    note: "The business's own Vercel projects, deployments and domains, read-only: when the site changed and what is live." },
  { specs: ["netlify.com"], provider: "netlify", name: "Netlify", platform: "website", prefix: "site.netlify", docs: "https://open-api.netlify.com/",
    auth: { kind: "bearer" }, skip: /\/(user|accounts\/[^/]+\/members|deploy_keys|hooks|env|access_tokens|service-instances|oauth)(\/|$)/,
    connect: KEY("In Netlify, User settings, Applications, create a personal access token and paste it.", "https://app.netlify.com/user/applications"),
    note: "The business's own Netlify sites, deploys and forms, read-only: when the site changed and what is live." },
]

// Operations that touch credentials, sign-in or webhooks are never generated.
const DENY = /token|secret|password|credential|oauth|\/auth(\/|$)|login|logout|api[-_]?keys?(\/|$)|webhook|sessions?(\/|$)|signing/i
const short = (s: unknown, max = 140) => String(s ?? "").replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").trim().slice(0, max)
const idPart = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
const fit = (id: string) => id.length <= 60 ? id : `${id.slice(0, 51)}_${Buffer.from(id).toString("base64url").slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x")}`

type J = Record<string, unknown>
const files = (root: string, spec: string): string[] => {
  const p = join(root, spec)
  if (!statSync(p).isDirectory()) return [p]
  return readdirSync(p).flatMap(n => files(p, n)).filter(f => /\/(openapi|swagger)\.yaml$/.test(f) || statSync(f).isFile() && /(openapi|swagger)\.yaml$/.test(f))
}
const resolve = (spec: J, v: unknown): J | undefined => {
  let x = v as J | undefined, guard = 0
  while (x && typeof x["$ref"] === "string" && guard++ < 8) {
    const ref = String(x["$ref"])
    if (!ref.startsWith("#/")) return undefined
    x = ref.slice(2).split("/").reduce<unknown>((o, k) => (o as J | undefined)?.[k.replace(/~1/g, "/").replace(/~0/g, "~")], spec) as J | undefined
  }
  return x
}
/** The spec's own server, with variables at their defaults; https only. */
const serverOf = (spec: J): string | null => {
  if (typeof spec["swagger"] === "string") {
    const schemes = (spec["schemes"] as string[] | undefined) ?? ["https"]
    if (!spec["host"]) return null
    return `${schemes.includes("https") || schemes.includes("http") ? "https" : "https"}://${spec["host"]}${spec["basePath"] ?? ""}`.replace(/\/$/, "")
  }
  const s = ((spec["servers"] as J[] | undefined) ?? []).find(x => /^https?:\/\//.test(String(x["url"])))
  if (!s) return null
  let url = String(s["url"])
  for (const [k, v] of Object.entries((s["variables"] as Record<string, J> | undefined) ?? {})) url = url.split(`{${k}}`).join(String(v["default"] ?? ""))
  return /\{/.test(url) ? null : url.replace(/^http:/, "https:").replace(/\/$/, "")
}
/** The spec's own auth when the source does not set one. */
const authOf = (spec: J): Auth => {
  const schemes = Object.values(((spec["components"] as J | undefined)?.["securitySchemes"] ?? spec["securityDefinitions"] ?? {}) as Record<string, J>)
  const key = schemes.find(s => s["type"] === "apiKey" && (s["in"] === "query" || s["in"] === "header") && String(s["name"]).toLowerCase() !== "authorization")
  if (key) return { kind: "api_key", in: key["in"] as "query" | "header", name: String(key["name"]) }
  if (schemes.some(s => s["type"] === "http" && String(s["scheme"]).toLowerCase() === "basic")) return { kind: "basic" }
  if (schemes.some(s => s["type"] === "oauth2" || s["type"] === "http")) return { kind: "bearer" }
  return { kind: "none" }
}

interface GenParam { n: string; in: "path" | "query" | "header"; r?: 1; t: "s" | "i" | "b"; e?: string[] }
interface GenOp { id: string; title: string; path: string; params: GenParam[]; docs: string }

const opsOf = (spec: J, src: Source, base: string): GenOp[] => {
  const out: GenOp[] = []
  const authNames = new Set(src.auth?.kind === "api_key" ? [src.auth.name.toLowerCase()] : src.auth?.kind === "api_key_pair" ? src.auth.names.map(n => n.toLowerCase()) : [])
  const specAuth = authOf(spec)
  if (specAuth.kind === "api_key") authNames.add(specAuth.name.toLowerCase())
  for (const [path, raw] of Object.entries((spec["paths"] ?? {}) as Record<string, J>)) {
    const item = resolve(spec, raw) ?? {}
    const op = resolve(spec, item["get"])
    if (!op || op["deprecated"] || DENY.test(path) || src.skip?.test(path) || DENY.test(String(op["operationId"] ?? ""))) continue
    const params = [...((item["parameters"] as unknown[]) ?? []), ...((op["parameters"] as unknown[]) ?? [])].map(p => resolve(spec, p)).filter((p): p is J => !!p)
      .filter(p => (p["in"] === "path" || p["in"] === "query" || (p["in"] === "header" && p["required"])) && typeof p["name"] === "string")
      .filter(p => /^[A-Za-z0-9_.:-]{1,60}$/.test(String(p["name"])) && !authNames.has(String(p["name"]).toLowerCase()) && !/^(authorization|cookie|host|content-length)$/i.test(String(p["name"])))
    const unique = [...new Map(params.map(p => [`${p["in"]}:${p["name"]}`, p])).values()]
    const gp: GenParam[] = unique.slice(0, 25).map(p => {
      const schema = (resolve(spec, p["schema"]) ?? p) as J
      const t = schema["type"] === "integer" || schema["type"] === "number" ? "i" as const : schema["type"] === "boolean" ? "b" as const : "s" as const
      const e = Array.isArray(schema["enum"]) && (schema["enum"] as unknown[]).length <= 30 && (schema["enum"] as unknown[]).every(x => typeof x === "string") ? schema["enum"] as string[] : undefined
      return { n: String(p["name"]), in: p["in"] as GenParam["in"], ...(p["required"] || p["in"] === "path" ? { r: 1 as const } : {}), t, ...(e ? { e } : {}) }
    })
    // Every placeholder in the path must be a documented parameter.
    for (const m of path.matchAll(/\{([^}]+)\}/g)) if (!gp.some(p => p.in === "path" && p.n === m[1])) gp.push({ n: m[1]!, in: "path", r: 1, t: "s" })
    if (gp.some(p => p.in === "path" && !/^[A-Za-z0-9_.-]+$/.test(p.n))) continue
    const name = op["operationId"] ? idPart(String(op["operationId"])) : idPart(path.replace(/\{[^}]+\}/g, "one"))
    if (!name) continue
    const ext = (op["externalDocs"] as J | undefined)?.["url"]
    out.push({ id: fit(`${src.prefix}.${name}`), title: short(op["summary"] ?? op["description"] ?? `GET ${path}`, 120) || `GET ${path}`, path: `${base}${path}`.replace(base, ""),
      params: gp, docs: typeof ext === "string" && /^https:\/\//.test(ext) ? ext : src.docs })
  }
  return out
}

const main = () => {
  const root = process.argv[2]
  if (!root) { console.error("usage: generate-directory-endpoints.ts <openapi-directory>/APIs"); process.exit(2) }
  const providers: J[] = [], outFiles: J[] = []
  const usedIds = new Set<string>()
  let total = 0
  for (const src of SOURCES) {
    const specFiles = src.specs.flatMap(s => files(root, s))
    // Several files of one provider can share a base (different API families); each becomes its own file entry.
    const hosts = new Set<string>()
    let auth: Auth | null = src.auth ?? null, count = 0
    for (const f of specFiles) {
      const spec = parse(readFileSync(f, "utf8"), { maxAliasCount: -1 }) as J
      const base = src.base ?? serverOf(spec)
      if (!base || !base.startsWith("https://")) { console.warn(`skip ${f}: no https server`); continue }
      auth ??= authOf(spec)
      const ops = opsOf(spec, src, base).filter(o => !usedIds.has(o.id) && usedIds.add(o.id))
      if (!ops.length) continue
      hosts.add(new URL(base).hostname.toLowerCase())
      outFiles.push({ provider: src.provider, platform: src.platform, base, name: src.name, ops })
      count += ops.length
    }
    if (!count) { console.warn(`skip ${src.provider}: no read operations`); continue }
    const a = auth ?? { kind: "none" }
    providers.push({ id: src.provider, name: src.name, hosts: [...hosts], auth: a, note: src.note, ...(src.paid ? { paid: true } : {}), ...(src.headers ? { headers: src.headers } : {}),
      ...(a.kind !== "none" && src.connect ? { connect: { ...src.connect, format: a.kind === "basic" || a.kind === "client_credentials" || a.kind === "api_key_pair" ? "^[^\\s:]{2,200}:[^\\s]{2,300}$" : "^[\\x21-\\x7e]{6,400}$" } } : {}) })
    total += count
    console.log(`${src.provider.padEnd(18)} ${String(count).padStart(4)} read operations  ${[...hosts].join(", ")}`)
  }
  writeFileSync(join(import.meta.dirname, "../src/research/endpoints/generated/directory.json"), JSON.stringify({ source: "https://github.com/APIs-guru/openapi-directory (CC0)", providers, files: outFiles }))
  console.log(`${providers.length} providers, ${total} read operations`)
}
main()
