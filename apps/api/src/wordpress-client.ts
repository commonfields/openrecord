// WordPress REST client for a connected site. Every call goes over HTTPS to
// the site's own host, through the same pinned transport as OpenRecord's safe
// fetcher: the host is resolved once, every address must be public, and the
// connection is pinned to it, so a site URL cannot reach a private network.
// Redirects are not followed. Responses are size-capped and WordPress's own
// error text is never passed on; failures become a small set of reasons.
//
// The change logic is pure: what each kind of change writes, the FAQ section
// and its structured data, and whether WordPress stored exactly that.
import { createHash } from "node:crypto"
import { defaultTransport, isForbiddenIp, readCapped, type HttpTransport } from "@openrecord/representation"

export type WpFailure = "INVALID_SITE" | "NOT_PUBLIC" | "AUTH" | "FORBIDDEN" | "NOT_FOUND" | "REDIRECTED" | "RATE_LIMITED" | "REST_UNAVAILABLE" | "UNAVAILABLE" | "MALFORMED"
export class WpError extends Error {
  constructor(readonly reason: WpFailure) { super(reason) }
}
export interface WpSite { readonly siteUrl: string; readonly username: string; readonly password: string }
export type SeoPlugin = "YOAST" | "RANK_MATH" | "NONE"

/** The site's address as stored: https, no credentials, query or fragment, no trailing slash. */
export function normalizeSiteUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !u.hostname.includes(".")) return null
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`
  } catch { return null }
}

const MAX_RESPONSE = 4_000_000
/** One REST call: method, path under /wp-json, optional JSON body. Returns the parsed JSON. */
export async function wpRequest(site: Pick<WpSite, "siteUrl"> & Partial<WpSite>, method: "GET" | "POST" | "DELETE", path: string, body?: unknown,
  transport: HttpTransport = defaultTransport(20_000)): Promise<unknown> {
  const base = normalizeSiteUrl(site.siteUrl)
  if (!base) throw new WpError("INVALID_SITE")
  const url = new URL(`${base}/wp-json${path}`)
  let addresses: string[]
  try { addresses = await transport.lookup(url.hostname) } catch { throw new WpError("UNAVAILABLE") }
  if (!addresses.length || addresses.some(isForbiddenIp)) throw new WpError("NOT_PUBLIC")
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "OpenRecord-WordPress/1" }
  if (site.username && site.password) headers["authorization"] = `Basic ${Buffer.from(`${site.username}:${site.password}`).toString("base64")}`
  if (body !== undefined) headers["content-type"] = "application/json"
  let res
  try {
    res = await transport.fetch(url.toString(), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(25_000), connectIp: addresses[0]!, servername: url.hostname })
  } catch { throw new WpError("UNAVAILABLE") }
  const { bytes, truncated } = await readCapped(res.body, MAX_RESPONSE).catch(() => { throw new WpError("UNAVAILABLE") })
  if (res.status >= 300 && res.status < 400) throw new WpError("REDIRECTED")
  if (res.status === 401) throw new WpError("AUTH")
  if (res.status === 403) throw new WpError("FORBIDDEN")
  if (res.status === 404) throw new WpError(path === "/" ? "REST_UNAVAILABLE" : "NOT_FOUND")
  if (res.status === 429) throw new WpError("RATE_LIMITED")
  if (res.status < 200 || res.status >= 300) throw new WpError("UNAVAILABLE")
  if (truncated) throw new WpError("MALFORMED")
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) } catch { throw new WpError("MALFORMED") }
}

/** Which SEO plugin answers on the site's REST API, from the namespaces it lists. */
export const seoPluginOf = (namespaces: unknown): SeoPlugin => {
  const list = Array.isArray(namespaces) ? namespaces.map(String) : []
  return list.some(n => n.startsWith("yoast/")) ? "YOAST" : list.some(n => n.startsWith("rankmath/")) ? "RANK_MATH" : "NONE"
}
/** The post meta keys each SEO plugin reads its title and description from. */
export const SEO_META: Readonly<Record<Exclude<SeoPlugin, "NONE">, { title: string; description: string }>> = {
  YOAST: { title: "_yoast_wpseo_title", description: "_yoast_wpseo_metadesc" },
  RANK_MATH: { title: "rank_math_title", description: "rank_math_description" },
}

// ---------------------------------------------------------------- changes

export type ChangeKind = "UPDATE_COPY" | "SET_SEO" | "ADD_FAQ" | "CREATE_POST"
/** The fields a change writes, in WordPress terms. */
export interface WpValues { title?: string; content?: string; meta?: Record<string, string>; status?: "publish" | "draft" }
export interface Faq { readonly question: string; readonly answer: string }

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
/** An FAQ section in block-editor markup, with matching FAQPage structured data when scripts are allowed. */
export function faqBlock(faq: ReadonlyArray<Faq>, withStructuredData: boolean): string {
  const parts = [
    '<!-- wp:heading -->\n<h2 class="wp-block-heading">Frequently asked questions</h2>\n<!-- /wp:heading -->',
    ...faq.flatMap(f => [
      `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${escapeHtml(f.question.trim())}</h3>\n<!-- /wp:heading -->`,
      `<!-- wp:paragraph -->\n<p>${escapeHtml(f.answer.trim())}</p>\n<!-- /wp:paragraph -->`,
    ]),
  ]
  if (withStructuredData) {
    const json = JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(f => ({
      "@type": "Question", name: f.question.trim(), acceptedAnswer: { "@type": "Answer", text: f.answer.trim() } })) }, null, 2).replace(/<\//g, "<\\/")
    parts.push(`<!-- wp:html -->\n<script type="application/ld+json">\n${json}\n</script>\n<!-- /wp:html -->`)
  }
  return parts.join("\n\n")
}

export interface WpPost { readonly id: number; readonly title: string; readonly content: string; readonly link: string | null; readonly modified: string | null; readonly status: string; readonly meta: Record<string, string> }
/** A post or page as the REST API returns it in the edit context. */
export function toPost(raw: unknown): WpPost {
  const r = (raw ?? {}) as { id?: unknown; title?: { raw?: unknown }; content?: { raw?: unknown }; link?: unknown; modified_gmt?: unknown; status?: unknown; meta?: unknown }
  if (typeof r.id !== "number") throw new WpError("MALFORMED")
  const meta: Record<string, string> = {}
  if (r.meta && typeof r.meta === "object" && !Array.isArray(r.meta)) for (const [k, v] of Object.entries(r.meta)) if (typeof v === "string") meta[k] = v
  return { id: r.id, title: typeof r.title?.raw === "string" ? r.title.raw : "", content: typeof r.content?.raw === "string" ? r.content.raw : "",
    link: typeof r.link === "string" ? r.link : null, modified: typeof r.modified_gmt === "string" ? r.modified_gmt : null, status: typeof r.status === "string" ? r.status : "", meta }
}

export interface ChangeInput {
  readonly kind: ChangeKind
  readonly title?: string | undefined
  readonly content?: string | undefined
  readonly seoTitle?: string | undefined
  readonly seoDescription?: string | undefined
  readonly faq?: ReadonlyArray<Faq> | undefined
}
export type ChangeRefusal = "NOTHING_TO_CHANGE" | "SEO_PLUGIN_MISSING" | "MISSING_FIELDS"
/**
 * What a change writes and what it replaces. `current` is the post as it is
 * now (null for a new post). Returns the before and after values, or why the
 * change cannot be made.
 */
export function planChange(input: ChangeInput, current: WpPost | null, seo: SeoPlugin, canAddScripts: boolean):
  { before: WpValues; after: WpValues } | { refused: ChangeRefusal } {
  if (input.kind === "CREATE_POST") {
    if (!input.title?.trim() || !input.content?.trim()) return { refused: "MISSING_FIELDS" }
    return { before: {}, after: { title: input.title.trim(), content: input.content, status: "publish" } }
  }
  if (!current) return { refused: "MISSING_FIELDS" }
  if (input.kind === "UPDATE_COPY") {
    const after: WpValues = {}, before: WpValues = {}
    if (input.title !== undefined && input.title.trim() !== current.title) { after.title = input.title.trim(); before.title = current.title }
    if (input.content !== undefined && input.content !== current.content) { after.content = input.content; before.content = current.content }
    return Object.keys(after).length ? { before, after } : { refused: input.title === undefined && input.content === undefined ? "MISSING_FIELDS" : "NOTHING_TO_CHANGE" }
  }
  if (input.kind === "SET_SEO") {
    if (seo === "NONE") return { refused: "SEO_PLUGIN_MISSING" }
    const keys = SEO_META[seo], after: Record<string, string> = {}, before: Record<string, string> = {}
    if (input.seoTitle !== undefined && input.seoTitle.trim() !== (current.meta[keys.title] ?? "")) { after[keys.title] = input.seoTitle.trim(); before[keys.title] = current.meta[keys.title] ?? "" }
    if (input.seoDescription !== undefined && input.seoDescription.trim() !== (current.meta[keys.description] ?? "")) { after[keys.description] = input.seoDescription.trim(); before[keys.description] = current.meta[keys.description] ?? "" }
    return Object.keys(after).length ? { before: { meta: before }, after: { meta: after } } : { refused: input.seoTitle === undefined && input.seoDescription === undefined ? "MISSING_FIELDS" : "NOTHING_TO_CHANGE" }
  }
  if (!input.faq?.length) return { refused: "MISSING_FIELDS" }
  return { before: { content: current.content }, after: { content: `${current.content.replace(/\s+$/, "")}\n\n${faqBlock(input.faq, canAddScripts)}\n` } }
}

/** Whether WordPress stored exactly the approved values. */
export function stored(post: WpPost, after: WpValues): boolean {
  if (after.title !== undefined && post.title !== after.title) return false
  if (after.content !== undefined && post.content.trim() !== after.content.trim()) return false
  for (const [k, v] of Object.entries(after.meta ?? {})) if ((post.meta[k] ?? "") !== v) return false
  return true
}

/** Server-owned identity of a change request: the same change from the same person replays. */
export const changeKey = (parts: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
