// The business's own revenue, banking, product analytics and email accounts,
// read with keys its team adds on the Channels page: RevenueCat, Polar,
// Paddle, Lemon Squeezy and Shopify for sales and subscriptions; Mercury and
// Ramp for cash and spend; PostHog and Plausible for product and website
// analytics; Klaviyo, Mailchimp and Resend for email. Every endpoint is a read,
// on the provider's documented API, with the key on the server only.
import { Schema } from "effect"
import { compactJson } from "./generated.js"
import { arr, none, obj, ok } from "./defs-public.js"
import { ACCOUNT_HOST, type AnyEndpoint, type Parsed, type Provider } from "./types.js"

// ---- Providers ----------------------------------------------------------------

export const BUSINESS_PROVIDERS: ReadonlyArray<Provider> = [
  { id: "revenuecat", name: "RevenueCat", hosts: ["api.revenuecat.com"], auth: { kind: "bearer" },
    connect: { how: "In RevenueCat, Project settings, API keys, create a secret API key (v2) with read-only permissions.", url: "https://app.revenuecat.com/", format: /^sk_[A-Za-z0-9_]{20,}$/, example: "sk_..." },
    note: "The business's own in-app subscription data as RevenueCat reports it: subscribers, trials, MRR and revenue. Store fees and refunds follow RevenueCat's definitions." },
  { id: "polar", name: "Polar", hosts: ["api.polar.sh"], auth: { kind: "bearer" },
    connect: { how: "In Polar, Settings, Developers, create an organization access token with read scopes (metrics, orders, subscriptions).", url: "https://polar.sh/dashboard", format: /^polar_[A-Za-z0-9_]{20,}$/, example: "polar_oat_..." },
    note: "The business's own Polar sales, orders and subscriptions." },
  { id: "paddle", name: "Paddle", hosts: ["api.paddle.com"], auth: { kind: "bearer" },
    connect: { how: "In Paddle, Developer tools, Authentication, create an API key with read permissions for transactions and subscriptions.", url: "https://vendors.paddle.com/authentication-v2", format: /^(pdl_(live|sdbx)_apikey_)?[A-Za-z0-9_]{20,}$/, example: "pdl_live_apikey_..." },
    note: "The business's own Paddle Billing transactions and subscriptions." },
  { id: "lemonsqueezy", name: "Lemon Squeezy", hosts: ["api.lemonsqueezy.com"], auth: { kind: "bearer" },
    connect: { how: "In Lemon Squeezy, Settings, API, create an API key.", url: "https://app.lemonsqueezy.com/settings/api", format: /^[A-Za-z0-9._-]{40,}$/, example: "eyJ0eXAi..." },
    note: "The business's own Lemon Squeezy orders and subscriptions." },
  { id: "shopify", name: "Shopify", hosts: [], auth: { kind: "api_key", in: "header", name: "X-Shopify-Access-Token" },
    accountHost: { pattern: /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/, split: s => { const at = s.indexOf(":"); return at > 0 ? { host: s.slice(0, at), secret: s.slice(at + 1) } : null } },
    connect: { how: "In Shopify admin, Settings, Apps, Develop apps, create an app with read_orders and read_customers, install it, and paste your-store.myshopify.com:the Admin API access token.", url: "https://help.shopify.com/en/manual/apps/app-types/custom-apps", format: /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com:shpat_[A-Za-z0-9]{20,}$/, example: "your-store.myshopify.com:shpat_..." },
    note: "The business's own Shopify store: orders and customers, read-only." },
  { id: "mercury", name: "Mercury", hosts: ["api.mercury.com"], auth: { kind: "bearer" },
    connect: { how: "In Mercury, Settings, API tokens, create a read-only token.", url: "https://app.mercury.com/settings/tokens", format: /^[A-Za-z0-9:_=+/-]{20,}$/, example: "secret-token:..." },
    note: "The business's own Mercury bank accounts and transactions, read-only. Card and bank lines are what the bank shows, not categorized marketing spend." },
  { id: "ramp", name: "Ramp", hosts: ["api.ramp.com"], auth: { kind: "client_credentials", tokenUrl: "https://api.ramp.com/developer/v1/token", scope: "transactions:read business:read" },
    connect: { how: "In Ramp, Settings, Developer API, create an app with the transactions:read and business:read scopes, and paste client_id:client_secret.", url: "https://app.ramp.com/settings/ramp-developer", format: /^[A-Za-z0-9_-]{8,}:[A-Za-z0-9_-]{16,}$/, example: "ramp_id_...:ramp_sec_..." },
    note: "The business's own Ramp card transactions with merchant and category, read-only. Useful for real marketing spend next to results." },
  { id: "posthog", name: "PostHog", hosts: ["us.posthog.com", "eu.posthog.com"], auth: { kind: "bearer" },
    connect: { how: "In PostHog, Settings, Personal API keys, create a key with read access to the project (query:read, insight:read).", url: "https://us.posthog.com/settings/user-api-keys", format: /^phx_[A-Za-z0-9]{20,}$/, example: "phx_..." },
    note: "The business's own product analytics in PostHog: events, insights and funnels as PostHog computes them." },
  { id: "plausible", name: "Plausible Analytics", hosts: ["plausible.io"], auth: { kind: "bearer" },
    connect: { how: "In Plausible, Settings, API keys, create a Stats API key.", url: "https://plausible.io/settings/api-keys", format: /^[A-Za-z0-9_-]{30,}$/, example: "..." },
    note: "The business's own website visitors from Plausible: privacy-friendly counts, not individual people." },
  { id: "klaviyo", name: "Klaviyo", hosts: ["a.klaviyo.com"], auth: { kind: "api_key", in: "header", name: "Authorization", prefix: "Klaviyo-API-Key " },
    headers: () => ({ revision: "2024-10-15" }),
    connect: { how: "In Klaviyo, Settings, API keys, create a private key with read-only access to campaigns, flows, lists and metrics.", url: "https://www.klaviyo.com/settings/account/api-keys", format: /^pk_[A-Za-z0-9]{20,}$/, example: "pk_..." },
    note: "The business's own Klaviyo email and SMS campaigns, flows, lists and metrics." },
  { id: "mailchimp", name: "Mailchimp", hosts: [], auth: { kind: "basic" },
    accountHost: { pattern: /^[a-z]{2,4}\d{1,3}\.api\.mailchimp\.com$/, split: s => { const m = /^([A-Za-z0-9]{20,})-([a-z]{2,4}\d{1,3})$/.exec(s); return m ? { host: `${m[2]}.api.mailchimp.com`, secret: `openrecord:${m[1]}-${m[2]}` } : null } },
    connect: { how: "In Mailchimp, Profile, Extras, API keys, create a key. It ends with your data centre, for example -us21.", url: "https://us1.admin.mailchimp.com/account/api/", format: /^[A-Za-z0-9]{20,}-[a-z]{2,4}\d{1,3}$/, example: "0123abcd...-us21" },
    note: "The business's own Mailchimp audiences and campaign reports." },
  { id: "resend", name: "Resend", hosts: ["api.resend.com"], auth: { kind: "bearer" },
    connect: { how: "In Resend, API keys, create a key with full access (Resend has no read-only key; OpenRecord only reads with it).", url: "https://resend.com/api-keys", format: /^re_[A-Za-z0-9_]{20,}$/, example: "re_..." },
    note: "The business's own Resend emails, audiences and sending domains, read-only." },
]

// ---- Shared parsing -------------------------------------------------------------

/** A list under `key` (or the top level), compacted, with a "not listed is not zero" note when empty. */
const listed = (who: string, key: string | null, note: string) => (json: unknown): Parsed => {
  const list = key === null ? arr(json) : arr(obj(json)[key])
  if (!list.length) return none(`${who} returned nothing for this. Not listed is not zero.`)
  return ok({ label: "SEEN", items: compactJson(list), count: list.length }, { note })
}
/** The whole answer, compacted, when it has anything in it. */
const whole = (who: string, note: string) => (json: unknown): Parsed =>
  json && typeof json === "object" && Object.keys(json as object).length ? ok({ label: "SEEN", result: compactJson(json) }, { note }) : none(`${who} returned nothing for this.`)

const Day = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/))
const Limit = (max: number) => Schema.optional(Schema.Int.pipe(Schema.between(1, max)))
const Id = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,80}$/))
const Empty = Schema.Struct({})
const Range = Schema.Struct({ from: Day, to: Day })
const iso = (d: string, end = false) => `${d}T${end ? "23:59:59" : "00:00:00"}Z`

// ---- Revenue and subscriptions --------------------------------------------------------

const RC = "https://api.revenuecat.com/v2"
const RC_NOTE = "As the business's own RevenueCat reports it now."
const Project = Schema.Struct({ project: Id })

const POLAR = "https://api.polar.sh/v1"
const POLAR_NOTE = "As the business's own Polar account reports it."
const PolarMetrics = Schema.Struct({ from: Day, to: Day, interval: Schema.optional(Schema.Literal("day", "week", "month")) })

const PADDLE = "https://api.paddle.com"
const PADDLE_NOTE = "As the business's own Paddle Billing account reports it."

const LS = "https://api.lemonsqueezy.com/v1"
const LS_NOTE = "As the business's own Lemon Squeezy store reports it."
const JSONAPI = { accept: "application/vnd.api+json" }

const SHOP = `https://${ACCOUNT_HOST}/admin/api/2025-07`
const SHOP_NOTE = "As the business's own Shopify store holds it. Order source fields are Shopify's, not proof of what caused a sale."

// ---- Cash and spend ---------------------------------------------------------------

const MERCURY = "https://api.mercury.com/api/v1"
const MERCURY_NOTE = "As the business's own Mercury accounts show it now."
const RAMP = "https://api.ramp.com/developer/v1"
const RAMP_NOTE = "As the business's own Ramp account shows it. Categories are Ramp's or the team's, not OpenRecord's."

// ---- Analytics --------------------------------------------------------------------

const PostHogQuery = Schema.Struct({
  region: Schema.optional(Schema.Literal("us", "eu")),
  project: Schema.String.pipe(Schema.pattern(/^\d{1,12}$/)),
  query: Schema.String.pipe(Schema.minLength(7), Schema.maxLength(4000), Schema.filter(q => /^\s*select\b/i.test(q) && !/;\s*\S/.test(q))),
})
const PostHogProject = Schema.Struct({ region: Schema.optional(Schema.Literal("us", "eu")), project: Schema.String.pipe(Schema.pattern(/^\d{1,12}$/)), limit: Limit(100) })
const ph = (region: "us" | "eu" | undefined) => `https://${region ?? "us"}.posthog.com/api`
const POSTHOG_NOTE = "As the business's own PostHog project computes it."

const PlausibleQuery = Schema.Struct({
  site: Schema.String.pipe(Schema.pattern(/^[a-z0-9.-]{3,253}$/)),
  range: Schema.optional(Schema.Literal("day", "7d", "30d", "month", "6mo", "12mo")),
  by: Schema.optional(Schema.Literal("visit:source", "visit:referrer", "visit:utm_campaign", "event:page", "visit:country_name", "visit:device")),
})
const PLAUSIBLE_NOTE = "Plausible counts visitors without cookies; numbers are its estimates of unique visitors, not people."

// ---- Email ------------------------------------------------------------------------

const KLAVIYO = "https://a.klaviyo.com/api"
const KLAVIYO_NOTE = "As the business's own Klaviyo account holds it."
const MAILCHIMP = `https://${ACCOUNT_HOST}/3.0`
const MAILCHIMP_NOTE = "As the business's own Mailchimp account reports it. Opens are estimates (mail privacy features inflate them)."
const RESEND = "https://api.resend.com"
const RESEND_NOTE = "As the business's own Resend account holds it."

export const BUSINESS_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  // RevenueCat
  { id: "revenue.revenuecat.projects", provider: "revenuecat", platform: "revenue", title: "RevenueCat projects", label: "SEEN", input: Empty, docs: "https://www.revenuecat.com/docs/api-v2",
    description: "The RevenueCat projects this key can read, with their ids, to use with the other RevenueCat reads.", subject: () => "revenuecat projects",
    request: () => ({ method: "GET", url: `${RC}/projects` }), parse: listed("RevenueCat", "items", RC_NOTE) },
  { id: "revenue.revenuecat.overview", provider: "revenuecat", platform: "revenue", title: "RevenueCat subscription overview", label: "SEEN", input: Project, docs: "https://www.revenuecat.com/docs/api-v2",
    description: "The app's subscription headline numbers now: active subscriptions and trials, MRR, revenue and new customers over RevenueCat's last 28 days.",
    subject: (i: typeof Project.Type) => `revenuecat ${i.project} overview`,
    request: (i: typeof Project.Type) => ({ method: "GET", url: `${RC}/projects/${i.project}/metrics/overview` }), parse: listed("RevenueCat", "metrics", RC_NOTE) },
  // Polar
  { id: "revenue.polar.metrics", provider: "polar", platform: "revenue", title: "Polar revenue and orders over time", label: "SEEN", input: PolarMetrics, docs: "https://docs.polar.sh/api-reference/metrics/get",
    description: "Revenue, orders, average order, subscriptions and churn per day, week or month between two dates, as Polar computes them.",
    subject: (i: typeof PolarMetrics.Type) => `polar metrics ${i.from} to ${i.to}`,
    request: (i: typeof PolarMetrics.Type) => ({ method: "GET", url: `${POLAR}/metrics/`, query: { start_date: i.from, end_date: i.to, interval: i.interval ?? "day" } }), parse: whole("Polar", POLAR_NOTE) },
  { id: "revenue.polar.orders", provider: "polar", platform: "revenue", title: "Polar orders", label: "SEEN", input: Schema.Struct({ limit: Limit(100) }), docs: "https://docs.polar.sh/api-reference/orders/list",
    description: "The most recent orders with product, amount, currency, customer and date.", subject: () => "polar orders",
    request: (i: { limit?: number }) => ({ method: "GET", url: `${POLAR}/orders/`, query: { limit: i.limit ?? 50, sorting: "-created_at" } }), parse: listed("Polar", "items", POLAR_NOTE) },
  { id: "revenue.polar.subscriptions", provider: "polar", platform: "revenue", title: "Polar active subscriptions", label: "SEEN", input: Schema.Struct({ limit: Limit(100) }), docs: "https://docs.polar.sh/api-reference/subscriptions/list",
    description: "Active subscriptions with product, amount, interval and when each started.", subject: () => "polar subscriptions",
    request: (i: { limit?: number }) => ({ method: "GET", url: `${POLAR}/subscriptions/`, query: { active: true, limit: i.limit ?? 50 } }), parse: listed("Polar", "items", POLAR_NOTE) },
  // Paddle
  { id: "revenue.paddle.transactions", provider: "paddle", platform: "revenue", title: "Paddle completed transactions", label: "SEEN", input: Range, docs: "https://developer.paddle.com/api-reference/transactions/list-transactions",
    description: "Completed transactions between two dates with totals, currency, customer and items.", subject: (i: typeof Range.Type) => `paddle transactions ${i.from} to ${i.to}`,
    request: (i: typeof Range.Type) => ({ method: "GET", url: `${PADDLE}/transactions`, query: { status: "completed", "created_at[GTE]": iso(i.from), "created_at[LTE]": iso(i.to, true), per_page: 100 } }), parse: listed("Paddle", "data", PADDLE_NOTE) },
  { id: "revenue.paddle.subscriptions", provider: "paddle", platform: "revenue", title: "Paddle active subscriptions", label: "SEEN", input: Empty, docs: "https://developer.paddle.com/api-reference/subscriptions/list-subscriptions",
    description: "Active subscriptions with plan, price, billing interval and next billing date.", subject: () => "paddle subscriptions",
    request: () => ({ method: "GET", url: `${PADDLE}/subscriptions`, query: { status: "active", per_page: 100 } }), parse: listed("Paddle", "data", PADDLE_NOTE) },
  // Lemon Squeezy
  { id: "revenue.lemonsqueezy.orders", provider: "lemonsqueezy", platform: "revenue", title: "Lemon Squeezy orders", label: "SEEN", input: Empty, docs: "https://docs.lemonsqueezy.com/api/orders/list-all-orders",
    description: "The most recent orders with totals, currency, status and customer.", subject: () => "lemonsqueezy orders",
    request: () => ({ method: "GET", url: `${LS}/orders`, query: { "page[size]": 100, sort: "-created_at" }, headers: JSONAPI }), parse: listed("Lemon Squeezy", "data", LS_NOTE) },
  { id: "revenue.lemonsqueezy.subscriptions", provider: "lemonsqueezy", platform: "revenue", title: "Lemon Squeezy subscriptions", label: "SEEN", input: Empty, docs: "https://docs.lemonsqueezy.com/api/subscriptions/list-all-subscriptions",
    description: "Subscriptions with product, status, renewal date and price.", subject: () => "lemonsqueezy subscriptions",
    request: () => ({ method: "GET", url: `${LS}/subscriptions`, query: { "page[size]": 100 }, headers: JSONAPI }), parse: listed("Lemon Squeezy", "data", LS_NOTE) },
  // Shopify
  { id: "revenue.shopify.shop", provider: "shopify", platform: "revenue", title: "Shopify store", label: "SEEN", input: Empty, docs: "https://shopify.dev/docs/api/admin-rest/latest/resources/shop",
    description: "The store's name, domain, currency, plan and time zone.", subject: () => "shopify shop",
    request: () => ({ method: "GET", url: `${SHOP}/shop.json` }), parse: whole("Shopify", SHOP_NOTE) },
  { id: "revenue.shopify.orders", provider: "shopify", platform: "revenue", title: "Shopify orders", label: "SEEN", input: Range, docs: "https://shopify.dev/docs/api/admin-rest/latest/resources/order",
    description: "Orders between two dates with totals, currency, discount codes, source and referring site as Shopify recorded them.",
    subject: (i: typeof Range.Type) => `shopify orders ${i.from} to ${i.to}`,
    request: (i: typeof Range.Type) => ({ method: "GET", url: `${SHOP}/orders.json`, query: { status: "any", created_at_min: iso(i.from), created_at_max: iso(i.to, true), limit: 250,
      fields: "id,created_at,total_price,currency,financial_status,discount_codes,source_name,referring_site,landing_site,customer" } }), parse: listed("Shopify", "orders", SHOP_NOTE) },
  // Mercury
  { id: "finance.mercury.accounts", provider: "mercury", platform: "finance", title: "Mercury accounts and balances", label: "SEEN", input: Empty, docs: "https://docs.mercury.com/reference/getaccounts",
    description: "The business's Mercury accounts with current and available balances.", subject: () => "mercury accounts",
    request: () => ({ method: "GET", url: `${MERCURY}/accounts` }), parse: listed("Mercury", "accounts", MERCURY_NOTE) },
  { id: "finance.mercury.transactions", provider: "mercury", platform: "finance", title: "Mercury transactions", label: "SEEN", input: Schema.Struct({ account: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9-]{8,64}$/)), from: Day, to: Day }), docs: "https://docs.mercury.com/reference/listaccounttransactions",
    description: "One account's transactions between two dates with amount, counterparty and status; get the account id from Mercury accounts first.",
    subject: (i: { account: string; from: string; to: string }) => `mercury ${i.account} ${i.from} to ${i.to}`,
    request: (i: { account: string; from: string; to: string }) => ({ method: "GET", url: `${MERCURY}/account/${i.account}/transactions`, query: { start: i.from, end: i.to, limit: 500 } }), parse: listed("Mercury", "transactions", MERCURY_NOTE) },
  // Ramp
  { id: "finance.ramp.transactions", provider: "ramp", platform: "finance", title: "Ramp card transactions", label: "SEEN", input: Range, docs: "https://docs.ramp.com/developer-api/v1/reference/rest/transactions",
    description: "Card transactions between two dates with merchant, amount, category and cardholder; filter by merchant or category for marketing spend.",
    subject: (i: typeof Range.Type) => `ramp transactions ${i.from} to ${i.to}`,
    request: (i: typeof Range.Type) => ({ method: "GET", url: `${RAMP}/transactions`, query: { from_date: iso(i.from), to_date: iso(i.to, true), page_size: 100 } }), parse: listed("Ramp", "data", RAMP_NOTE) },
  // PostHog
  { id: "analytics.posthog.query", provider: "posthog", platform: "product-analytics", title: "PostHog query", label: "SEEN", input: PostHogQuery, docs: "https://posthog.com/docs/api/query",
    description: "A read-only HogQL SELECT over the project's events and persons (for example signups by day, or activation by source). Only SELECT is accepted.",
    subject: (i: typeof PostHogQuery.Type) => `posthog ${i.project} query`,
    request: (i: typeof PostHogQuery.Type) => ({ method: "POST", url: `${ph(i.region)}/projects/${i.project}/query/`, body: { query: { kind: "HogQLQuery", query: i.query } } }),
    parse: json => { const o = obj(json), rows = arr(o["results"]); return rows.length ? ok({ label: "SEEN", columns: compactJson(o["columns"]), rows: compactJson(rows.slice(0, 200)), count: rows.length }, { note: POSTHOG_NOTE }) : none("PostHog returned no rows. Not listed is not zero.") } },
  { id: "analytics.posthog.insights", provider: "posthog", platform: "product-analytics", title: "PostHog saved insights", label: "SEEN", input: PostHogProject, docs: "https://posthog.com/docs/api/insights",
    description: "The project's saved insights (trends, funnels, retention) with their names and last results.", subject: (i: typeof PostHogProject.Type) => `posthog ${i.project} insights`,
    request: (i: typeof PostHogProject.Type) => ({ method: "GET", url: `${ph(i.region)}/projects/${i.project}/insights/`, query: { limit: i.limit ?? 25, saved: true } }), parse: listed("PostHog", "results", POSTHOG_NOTE) },
  // Plausible
  { id: "analytics.plausible.query", provider: "plausible", platform: "analytics", title: "Plausible visitors", label: "SEEN", input: PlausibleQuery, docs: "https://plausible.io/docs/stats-api",
    description: "Visitors, visits, pageviews, bounce rate and visit duration for the site over a range, optionally broken down by source, referrer, campaign, page, country or device.",
    subject: (i: typeof PlausibleQuery.Type) => `plausible ${i.site} ${i.range ?? "30d"}${i.by ? ` by ${i.by}` : ""}`,
    request: (i: typeof PlausibleQuery.Type) => ({ method: "POST", url: "https://plausible.io/api/v2/query",
      body: { site_id: i.site, metrics: ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"], date_range: i.range ?? "30d", ...(i.by ? { dimensions: [i.by] } : {}) } }),
    parse: listed("Plausible", "results", PLAUSIBLE_NOTE) },
  // Klaviyo
  { id: "email.klaviyo.campaigns", provider: "klaviyo", platform: "email", title: "Klaviyo email campaigns", label: "SEEN", input: Empty, docs: "https://developers.klaviyo.com/en/reference/get_campaigns",
    description: "The account's email campaigns with name, status, audiences and send time.", subject: () => "klaviyo campaigns",
    request: () => ({ method: "GET", url: `${KLAVIYO}/campaigns`, query: { filter: "equals(messages.channel,'email')" } }), parse: listed("Klaviyo", "data", KLAVIYO_NOTE) },
  { id: "email.klaviyo.flows", provider: "klaviyo", platform: "email", title: "Klaviyo flows", label: "SEEN", input: Empty, docs: "https://developers.klaviyo.com/en/reference/get_flows",
    description: "Automated flows (welcome, abandoned cart and others) with status and trigger.", subject: () => "klaviyo flows",
    request: () => ({ method: "GET", url: `${KLAVIYO}/flows` }), parse: listed("Klaviyo", "data", KLAVIYO_NOTE) },
  { id: "email.klaviyo.lists", provider: "klaviyo", platform: "email", title: "Klaviyo lists", label: "SEEN", input: Empty, docs: "https://developers.klaviyo.com/en/reference/get_lists",
    description: "The account's lists with names and creation dates.", subject: () => "klaviyo lists",
    request: () => ({ method: "GET", url: `${KLAVIYO}/lists` }), parse: listed("Klaviyo", "data", KLAVIYO_NOTE) },
  // Mailchimp
  { id: "email.mailchimp.reports", provider: "mailchimp", platform: "email", title: "Mailchimp campaign reports", label: "SEEN", input: Schema.Struct({ limit: Limit(100) }), docs: "https://mailchimp.com/developer/marketing/api/reports/",
    description: "Sent campaigns with recipients, opens, clicks, unsubscribes and bounces.", subject: () => "mailchimp reports",
    request: (i: { limit?: number }) => ({ method: "GET", url: `${MAILCHIMP}/reports`, query: { count: i.limit ?? 25 } }), parse: listed("Mailchimp", "reports", MAILCHIMP_NOTE) },
  { id: "email.mailchimp.lists", provider: "mailchimp", platform: "email", title: "Mailchimp audiences", label: "SEEN", input: Empty, docs: "https://mailchimp.com/developer/marketing/api/lists/",
    description: "Audiences with member counts, growth and average open and click rates.", subject: () => "mailchimp audiences",
    request: () => ({ method: "GET", url: `${MAILCHIMP}/lists`, query: { count: 50 } }), parse: listed("Mailchimp", "lists", MAILCHIMP_NOTE) },
  // Resend
  { id: "email.resend.emails", provider: "resend", platform: "email", title: "Resend sent emails", label: "SEEN", input: Schema.Struct({ limit: Limit(100) }), docs: "https://resend.com/docs/api-reference/emails/list-emails",
    description: "Recently sent emails with subject, recipients, status (delivered, bounced, opened, clicked) and time.", subject: () => "resend emails",
    request: (i: { limit?: number }) => ({ method: "GET", url: `${RESEND}/emails`, query: { limit: i.limit ?? 50 } }), parse: listed("Resend", "data", RESEND_NOTE) },
  { id: "email.resend.audiences", provider: "resend", platform: "email", title: "Resend audiences", label: "SEEN", input: Empty, docs: "https://resend.com/docs/api-reference/audiences/list-audiences",
    description: "The account's audiences (contact lists) that marketing emails are sent to.", subject: () => "resend audiences",
    request: () => ({ method: "GET", url: `${RESEND}/audiences` }), parse: listed("Resend", "data", RESEND_NOTE) },
]
