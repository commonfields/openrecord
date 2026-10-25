import { load } from "cheerio"

/** Public profile hosts recognised on a homepage. A match proves only that the
 * page links there, not that the business controls the profile. */
const CHANNEL_HOSTS: ReadonlyArray<{ readonly kind: BusinessChannelKind; readonly hosts: ReadonlyArray<string> }> = [
  { kind: "LINKEDIN", hosts: ["linkedin.com"] },
  { kind: "X", hosts: ["x.com", "twitter.com"] },
  { kind: "FACEBOOK", hosts: ["facebook.com", "fb.com"] },
  { kind: "INSTAGRAM", hosts: ["instagram.com"] },
  { kind: "YOUTUBE", hosts: ["youtube.com", "youtu.be"] },
  { kind: "TIKTOK", hosts: ["tiktok.com"] },
  { kind: "PINTEREST", hosts: ["pinterest.com"] },
  { kind: "GITHUB", hosts: ["github.com"] },
  { kind: "GOOGLE_BUSINESS", hosts: ["g.page", "business.google.com", "maps.google.com", "goo.gl"] },
  { kind: "YELP", hosts: ["yelp.com"] },
  { kind: "G2", hosts: ["g2.com"] },
  { kind: "CAPTERRA", hosts: ["capterra.com"] },
  { kind: "PRODUCT_HUNT", hosts: ["producthunt.com"] },
]

export type BusinessChannelKind =
  | "LINKEDIN" | "X" | "FACEBOOK" | "INSTAGRAM" | "YOUTUBE" | "TIKTOK" | "PINTEREST" | "GITHUB"
  | "GOOGLE_BUSINESS" | "YELP" | "G2" | "CAPTERRA" | "PRODUCT_HUNT" | "EMAIL"

export interface BusinessSignals {
  readonly siteName: string | null
  readonly title: string | null
  readonly description: string | null
  readonly headings: ReadonlyArray<string>
  readonly pages: ReadonlyArray<{ readonly url: string; readonly label: string }>
  readonly channels: ReadonlyArray<{ readonly kind: BusinessChannelKind; readonly url: string }>
  readonly organization: { readonly name: string | null; readonly telephone: string | null; readonly email: string | null } | null
  readonly checks: {
    readonly hasTitle: boolean
    readonly hasDescription: boolean
    readonly hasCanonical: boolean
    readonly hasOrganizationData: boolean
    readonly h1Count: number
    readonly noindex: boolean
  }
}

// Page text is untrusted: every value is collapsed to one line and clipped, so
// it can be shown as a suggestion but never carries markup or long payloads.
const clean = (value: string | undefined | null, max: number): string | null => {
  if (!value) return null
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  return text.length === 0 ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const hostMatches = (host: string, candidate: string) => host === candidate || host.endsWith(`.${candidate}`)

const channelOf = (url: URL): BusinessChannelKind | null => {
  const host = url.hostname.toLowerCase()
  for (const entry of CHANNEL_HOSTS) if (entry.hosts.some(h => hostMatches(host, h))) return entry.kind
  return null
}

const ORG_TYPES = new Set(["Organization", "Corporation", "LocalBusiness", "OnlineBusiness", "OnlineStore", "ProfessionalService", "Store", "SoftwareApplication", "Restaurant"])

type JsonLdNode = Record<string, unknown>
const nodesOf = (value: unknown): JsonLdNode[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf)
  if (value && typeof value === "object") {
    const node = value as JsonLdNode
    return [node, ...("@graph" in node ? nodesOf(node["@graph"]) : [])]
  }
  return []
}
const typeOf = (node: JsonLdNode): string[] => {
  const t = node["@type"]
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : typeof t === "string" ? [t] : []
}
const str = (v: unknown) => (typeof v === "string" ? v : null)

/** Reads identity, structure and public profile links from one homepage.
 * Pure: no network, no model. */
export const extractBusinessSignals = (html: string, finalUrl: string): BusinessSignals => {
  const $ = load(html)
  const base = new URL(finalUrl)
  const meta = (selector: string) => clean($(selector).first().attr("content"), 300)

  const title = clean($("title").first().text(), 200)
  const description = meta('meta[name="description" i]') ?? meta('meta[property="og:description" i]')
  const siteName = meta('meta[property="og:site_name" i]') ?? meta('meta[name="application-name" i]')
  const robots = ($('meta[name="robots" i]').first().attr("content") ?? "").toLowerCase()

  const headings: string[] = []
  $("h1, h2").each((_i, el) => {
    const text = clean($(el).text(), 160)
    if (text && !headings.includes(text) && headings.length < 8) headings.push(text)
  })

  const pages: Array<{ url: string; label: string }> = []
  const channels: Array<{ kind: BusinessChannelKind; url: string }> = []
  const seenPages = new Set<string>()
  $("a[href]").each((_i, el) => {
    const href = ($(el).attr("href") ?? "").trim()
    if (/^mailto:/i.test(href)) {
      const address = href.slice(7).split("?")[0] ?? ""
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) && !channels.some(c => c.kind === "EMAIL")) channels.push({ kind: "EMAIL", url: `mailto:${address.slice(0, 200)}` })
      return
    }
    let url: URL
    try { url = new URL(href, base) } catch { return }
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    url.hash = ""
    const kind = channelOf(url)
    if (kind) {
      if (!channels.some(c => c.kind === kind)) channels.push({ kind, url: url.toString().slice(0, 500) })
      return
    }
    // Internal pages with a visible label become candidate landing pages.
    if (url.origin !== base.origin || url.pathname === base.pathname) return
    const key = `${url.origin}${url.pathname}`
    const label = clean($(el).text(), 60)
    if (!label || seenPages.has(key) || pages.length >= 12) return
    seenPages.add(key)
    pages.push({ url: key.slice(0, 500), label })
  })

  let organization: BusinessSignals["organization"] = null
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (organization) return
    let parsed: unknown
    try { parsed = JSON.parse($(el).text()) } catch { return }
    const org = nodesOf(parsed).find(n => typeOf(n).some(t => ORG_TYPES.has(t)))
    if (!org) return
    organization = { name: clean(str(org["name"]), 200), telephone: clean(str(org["telephone"]), 40), email: clean(str(org["email"]), 200) }
    const sameAs = org["sameAs"]
    for (const link of Array.isArray(sameAs) ? sameAs : [sameAs]) {
      if (typeof link !== "string") continue
      try {
        const url = new URL(link)
        const kind = channelOf(url)
        if (kind && !channels.some(c => c.kind === kind)) channels.push({ kind, url: url.toString().slice(0, 500) })
      } catch { /* not a URL */ }
    }
  })

  return {
    siteName,
    title,
    description,
    headings,
    pages,
    channels,
    organization,
    checks: {
      hasTitle: title !== null,
      hasDescription: meta('meta[name="description" i]') !== null,
      hasCanonical: $('link[rel="canonical" i]').length > 0,
      hasOrganizationData: organization !== null,
      h1Count: $("h1").length,
      noindex: robots.split(",").map(s => s.trim()).includes("noindex"),
    },
  }
}
