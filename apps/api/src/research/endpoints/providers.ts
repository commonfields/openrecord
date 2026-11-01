// Providers in the research endpoint catalog. Each is an official or public
// API; where it needs an account, it is the business's own (added by its team
// on the Channels page), never an OpenRecord account. "paid" providers bill
// the business's account and stay unused until the business connects one.
import type { Provider } from "./types.js"

const contact = (env: NodeJS.ProcessEnv) => env["RESEARCH_CONTACT"]?.trim() || null

export const PROVIDERS: ReadonlyArray<Provider> = [
  { id: "apple", name: "Apple App Store and Podcasts (public lookup)", hosts: ["itunes.apple.com"], auth: { kind: "none" },
    note: "Apple's public search and lookup: listings, ratings counts and recent reviews as Apple shows them. Ratings are for the country asked." },
  { id: "github", name: "GitHub", hosts: ["api.github.com"], auth: { kind: "bearer", optional: true },
    connect: { how: "Optional: create a fine-grained personal access token with public repository read access only, for higher rate limits.", url: "https://github.com/settings/personal-access-tokens/new", format: /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/, example: "github_pat_..." },
    note: "GitHub's public REST API. Without a token it allows 60 requests an hour from this server." },
  { id: "npm", name: "npm registry", hosts: ["api.npmjs.org", "registry.npmjs.org"], auth: { kind: "none" }, note: "npm's public registry and download counts (installs, including automated builds; not users)." },
  { id: "pypi", name: "PyPI", hosts: ["pypi.org", "pypistats.org"], auth: { kind: "none" }, note: "PyPI's public package data and download counts from the public PyPI statistics service (installs, not users)." },
  { id: "dockerhub", name: "Docker Hub", hosts: ["hub.docker.com"], auth: { kind: "none" }, note: "Docker Hub's public repository data. Pull counts include automated pulls." },
  { id: "wikimedia", name: "Wikipedia and Wikidata", hosts: ["en.wikipedia.org", "wikimedia.org", "www.wikidata.org"], auth: { kind: "none" },
    headers: env => ({ "user-agent": `OpenRecord-Research/1${contact(env) ? ` (${contact(env)})` : ""}` }),
    note: "Wikimedia's public APIs. Pageviews are measured views of the Wikipedia article (people interested in the company or topic), not the company's own site." },
  { id: "sec", name: "SEC EDGAR", hosts: ["data.sec.gov", "www.sec.gov"], auth: { kind: "none" },
    headers: env => contact(env) ? { "user-agent": contact(env)! } : null,
    note: "U.S. SEC public filings and reported financial facts for public companies. The SEC requires a declared contact (RESEARCH_CONTACT, for example \"Agency Name ops@agency.com\")." },
  { id: "google_api", name: "Google APIs (YouTube Data, Chrome real-user metrics)", hosts: ["www.googleapis.com", "youtube.googleapis.com", "chromeuxreport.googleapis.com"],
    auth: { kind: "api_key", in: "query", name: "key" },
    connect: { how: "In Google Cloud, create an API key, enable the YouTube Data API v3 and the Chrome UX Report API, and restrict the key to those two APIs.", url: "https://console.cloud.google.com/apis/credentials", format: /^AIza[0-9A-Za-z_-]{35}$/, example: "AIza..." },
    note: "Your own Google Cloud key and quota. YouTube search costs 100 quota units per call; channel and video reads cost 1." },
  { id: "pagespeed", name: "Google PageSpeed Insights", hosts: ["www.googleapis.com"], auth: { kind: "api_key", in: "query", name: "key", optional: true },
    connect: { how: "Optional: a Google Cloud API key with PageSpeed Insights enabled, for a higher quota.", url: "https://developers.google.com/speed/docs/insights/v5/get-started", format: /^AIza[0-9A-Za-z_-]{35}$/, example: "AIza..." },
    note: "A lab test from Google's servers plus real-user field data when the page has enough Chrome traffic." },
  { id: "reddit", name: "Reddit", hosts: ["oauth.reddit.com"], auth: { kind: "client_credentials", tokenUrl: "https://www.reddit.com/api/v1/access_token" },
    connect: { how: "Create a Reddit app of type \"script\" for your account and paste client_id:client_secret.", url: "https://www.reddit.com/prefs/apps", format: /^[A-Za-z0-9_-]{10,40}:[A-Za-z0-9_-]{20,60}$/, example: "abc123:xyz..." },
    note: "Reddit's official API under your own app and Reddit's API terms; read-only searches and community data." },
  { id: "producthunt", name: "Product Hunt", hosts: ["api.producthunt.com"], auth: { kind: "bearer" },
    connect: { how: "Create a Product Hunt API application and paste its developer token.", url: "https://www.producthunt.com/v2/oauth/applications", format: /^[A-Za-z0-9_-]{30,80}$/, example: "..." },
    note: "Product Hunt's official API under your own developer token." },
  { id: "bing_webmaster", name: "Bing Webmaster Tools", hosts: ["ssl.bing.com"], auth: { kind: "api_key", in: "query", name: "apikey" },
    connect: { how: "In Bing Webmaster Tools, Settings, API access, generate an API key for the account that owns the business's site.", url: "https://www.bing.com/webmasters", format: /^[A-Za-z0-9]{24,64}$/, example: "..." },
    note: "Bing search clicks, impressions and queries for the business's own verified site." },
  { id: "google_analytics", name: "Google Analytics (connected on Channels)", hosts: ["analyticsadmin.googleapis.com", "analyticsdata.googleapis.com"], auth: { kind: "google_connection", connection: "analytics" },
    note: "The business's own Google Analytics, through the Google connection on the Channels page (read-only)." },
  { id: "google_search_console", name: "Google Search Console (connected on Channels)", hosts: ["searchconsole.googleapis.com", "www.googleapis.com"], auth: { kind: "google_connection", connection: "search_console" },
    note: "The business's own Search Console site, through the Google connection on the Channels page (read-only)." },
  { id: "google_business_profile", name: "Google Business Profile (connected on Channels)", hosts: ["mybusinessbusinessinformation.googleapis.com", "mybusinessaccountmanagement.googleapis.com", "businessprofileperformance.googleapis.com", "mybusinessverifications.googleapis.com", "mybusiness.googleapis.com"],
    auth: { kind: "google_connection", connection: "business_profile" }, note: "The business's own Google Business Profile, through the Google Business connection on the Channels page. Reads only." },
  { id: "stripe", name: "Stripe (read-only restricted key)", hosts: ["api.stripe.com"], auth: { kind: "bearer" },
    connect: { how: "In Stripe, Developers, API keys, create a restricted key with Read access only for the data the agent should see. Full secret keys are refused.", url: "https://dashboard.stripe.com/apikeys", format: /^rk_(live|test)_[A-Za-z0-9]{20,}$/, example: "rk_live_..." },
    note: "The business's own Stripe data through a read-only restricted key; OpenRecord cannot charge, refund or change anything." },
  { id: "seo_data", name: "SEO data (your own DataForSEO account)", hosts: ["api.dataforseo.com"], auth: { kind: "basic" }, paid: true,
    connect: { how: "Optional and billed to your own DataForSEO account: paste your API login and password as login:password. Leave it unconnected and these numbers stay unknown.", url: "https://app.dataforseo.com/api-access", format: /^[^\s:]{3,120}:[^\s]{6,120}$/, example: "you@agency.com:password" },
    note: "Billed to the business's own account per request (roughly one to a few cents). Search volume, rankings, traffic and backlink numbers are this provider's estimates from its own databases, not measured visits." },
]
export const provider = (id: string) => PROVIDERS.find(p => p.id === id) ?? null
/** Providers a business can connect a credential for. */
export const CONNECTABLE = PROVIDERS.filter(p => p.connect)
