// Webflow Data API (v2) client for a connected site. Every call goes over
// HTTPS to api.webflow.com through the same pinned transport as OpenRecord's
// safe fetcher (the host is resolved once, every address must be public, the
// connection is pinned to it). Redirects are not followed, responses are
// size-capped, and Webflow's own error text is never passed on: failures
// become a small set of reasons.
//
// The change logic is pure: what each kind of change writes, what it
// replaces, and whether Webflow stored exactly that.
import { createHash } from "node:crypto"
import { defaultTransport, isForbiddenIp, readCapped, type HttpTransport } from "@openrecord/representation"

export type WfFailure = "AUTH" | "FORBIDDEN" | "NOT_FOUND" | "INVALID" | "CONFLICT" | "REDIRECTED" | "RATE_LIMITED" | "UNAVAILABLE" | "MALFORMED" | "NOT_PUBLIC"
export class WfError extends Error {
  constructor(readonly reason: WfFailure) { super(reason) }
}
export const WEBFLOW_API = "https://api.webflow.com/v2"
/** Webflow object IDs: 24 lowercase hex characters. */
export const WF_ID = /^[0-9a-f]{24}$/

const MAX_RESPONSE = 4_000_000
/** One Data API call: method, path under /v2, optional JSON body. Returns the parsed JSON (null for an empty reply). */
export async function wfRequest(token: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown,
  transport: HttpTransport = defaultTransport(20_000)): Promise<unknown> {
  const url = new URL(`${WEBFLOW_API}${path}`)
  let addresses: string[]
  try { addresses = await transport.lookup(url.hostname) } catch { throw new WfError("UNAVAILABLE") }
  if (!addresses.length || addresses.some(isForbiddenIp)) throw new WfError("NOT_PUBLIC")
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": "OpenRecord-Webflow/1" }
  if (body !== undefined) headers["content-type"] = "application/json"
  let res
  try {
    res = await transport.fetch(url.toString(), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(25_000), connectIp: addresses[0]!, servername: url.hostname })
  } catch { throw new WfError("UNAVAILABLE") }
  const { bytes, truncated } = await readCapped(res.body, MAX_RESPONSE).catch(() => { throw new WfError("UNAVAILABLE") })
  if (res.status >= 300 && res.status < 400) throw new WfError("REDIRECTED")
  if (res.status === 400) throw new WfError("INVALID")
  if (res.status === 401) throw new WfError("AUTH")
  if (res.status === 403) throw new WfError("FORBIDDEN")
  if (res.status === 404) throw new WfError("NOT_FOUND")
  if (res.status === 409) throw new WfError("CONFLICT")
  if (res.status === 429) throw new WfError("RATE_LIMITED")
  if (res.status < 200 || res.status >= 300) throw new WfError("UNAVAILABLE")
  if (truncated) throw new WfError("MALFORMED")
  if (!bytes.length) return null
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) } catch { throw new WfError("MALFORMED") }
}

// ---------------------------------------------------------------- shapes

const str = (v: unknown) => typeof v === "string" ? v : ""
const strOrNull = (v: unknown) => typeof v === "string" && v ? v : null

export interface WfSite { readonly id: string; readonly name: string; readonly shortName: string; readonly lastUpdated: string | null; readonly lastPublished: string | null; readonly domains: ReadonlyArray<{ readonly id: string; readonly url: string }> }
export function toSite(raw: unknown): WfSite {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r["id"] !== "string" || !WF_ID.test(r["id"])) throw new WfError("MALFORMED")
  const domains = (Array.isArray(r["customDomains"]) ? r["customDomains"] : []).flatMap((d: { id?: unknown; url?: unknown }) =>
    typeof d?.id === "string" && WF_ID.test(d.id) && typeof d.url === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))
      ? [{ id: d.id, url: d.url.replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase() }] : [])
  return { id: r["id"], name: str(r["displayName"]).slice(0, 200), shortName: str(r["shortName"]), lastUpdated: strOrNull(r["lastUpdated"]), lastPublished: strOrNull(r["lastPublished"]), domains }
}
/** The public address pages are checked at: the first custom domain, else the site's webflow.io address. */
export const liveBase = (site: WfSite): string | null => {
  const host = site.domains[0]?.url ?? (/^[a-z0-9-]+$/i.test(site.shortName) ? `${site.shortName.toLowerCase()}.webflow.io` : null)
  return host ? `https://${host}` : null
}

export interface WfPage {
  readonly id: string; readonly title: string; readonly slug: string; readonly seoTitle: string; readonly seoDescription: string
  readonly lastUpdated: string | null; readonly draft: boolean; readonly archived: boolean; readonly publishedPath: string | null; readonly collectionId: string | null
}
export function toPage(raw: unknown): WfPage {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r["id"] !== "string" || !WF_ID.test(r["id"])) throw new WfError("MALFORMED")
  const seo = (r["seo"] ?? {}) as Record<string, unknown>
  return { id: r["id"], title: str(r["title"]), slug: str(r["slug"]), seoTitle: str(seo["title"]), seoDescription: str(seo["description"]),
    lastUpdated: strOrNull(r["lastUpdated"]), draft: r["draft"] === true, archived: r["archived"] === true,
    publishedPath: strOrNull(r["publishedPath"]), collectionId: strOrNull(r["collectionId"]) }
}

/** The field types OpenRecord writes: text a person can read back. Images, references and options are left alone. */
export const TEXT_TYPES = new Set(["PlainText", "RichText", "Link", "Email", "Phone"])
export interface WfField { readonly slug: string; readonly name: string; readonly type: string; readonly required: boolean; readonly editable: boolean }
export interface WfCollection { readonly id: string; readonly name: string; readonly slug: string; readonly fields: ReadonlyArray<WfField> }
export function toCollection(raw: unknown): WfCollection {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r["id"] !== "string" || !WF_ID.test(r["id"])) throw new WfError("MALFORMED")
  const fields = (Array.isArray(r["fields"]) ? r["fields"] : []).flatMap((f: Record<string, unknown>) => typeof f?.["slug"] === "string"
    ? [{ slug: f["slug"], name: str(f["displayName"]), type: str(f["type"]), required: f["isRequired"] === true, editable: f["isEditable"] !== false }] : [])
  return { id: r["id"], name: str(r["displayName"]), slug: str(r["slug"]), fields }
}

export interface WfItem { readonly id: string; readonly fieldData: Readonly<Record<string, unknown>>; readonly lastUpdated: string | null; readonly lastPublished: string | null; readonly isDraft: boolean; readonly isArchived: boolean }
export function toItem(raw: unknown): WfItem {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r["id"] !== "string" || !WF_ID.test(r["id"])) throw new WfError("MALFORMED")
  const fd = r["fieldData"]
  return { id: r["id"], fieldData: fd && typeof fd === "object" && !Array.isArray(fd) ? fd as Record<string, unknown> : {},
    lastUpdated: strOrNull(r["lastUpdated"]), lastPublished: strOrNull(r["lastPublished"]), isDraft: r["isDraft"] === true, isArchived: r["isArchived"] === true }
}

/**
 * Whether something holds edits made after it was last published. Webflow's
 * own clock writes both times; a minute's grace covers the update a publish
 * itself records. When in doubt (never published, unreadable times) it says yes.
 */
export const hasUnpublishedEdits = (lastUpdated: string | null, lastPublished: string | null) => {
  if (!lastPublished) return true
  const u = Date.parse(lastUpdated ?? ""), p = Date.parse(lastPublished)
  if (Number.isNaN(p)) return true
  return Number.isNaN(u) ? false : u - p > 60_000
}

// ---------------------------------------------------------------- changes

export type ChangeKind = "SET_PAGE_SEO" | "UPDATE_CMS_ITEM" | "CREATE_CMS_ITEM"
/** The values a change writes, in Webflow terms. */
export interface WfValues { seo?: { title?: string; description?: string }; fieldData?: Record<string, string> }
export type ChangeRefusal = "NOTHING_TO_CHANGE" | "MISSING_FIELDS" | "FIELD_NOT_WRITABLE" | "SLUG_CHANGE" | "COLLECTION_NEEDS_OTHER_FIELDS"
export interface ChangeInput {
  readonly seoTitle?: string | undefined
  readonly seoDescription?: string | undefined
  readonly fields?: Readonly<Record<string, string>> | undefined
}
type Plan = { before: WfValues; after: WfValues } | { refused: ChangeRefusal }

/** A page's SEO title and description: what changes and what it replaces. */
export function planPageSeo(input: ChangeInput, page: WfPage): Plan {
  if (input.seoTitle === undefined && input.seoDescription === undefined) return { refused: "MISSING_FIELDS" }
  const after: { title?: string; description?: string } = {}, before: { title?: string; description?: string } = {}
  if (input.seoTitle !== undefined && input.seoTitle.trim() !== page.seoTitle) { after.title = input.seoTitle.trim(); before.title = page.seoTitle }
  if (input.seoDescription !== undefined && input.seoDescription.trim() !== page.seoDescription) { after.description = input.seoDescription.trim(); before.description = page.seoDescription }
  return Object.keys(after).length ? { before: { seo: before }, after: { seo: after } } : { refused: "NOTHING_TO_CHANGE" }
}

const writable = (c: WfCollection, slug: string) => c.fields.find(f => f.slug === slug && f.editable && (TEXT_TYPES.has(f.type) || slug === "name" || slug === "slug"))

/** New text for an existing item's fields. Its address (slug) is never changed: links to it would break. */
export function planItemUpdate(input: ChangeInput, collection: WfCollection, item: WfItem): Plan {
  const fields = Object.entries(input.fields ?? {})
  if (!fields.length) return { refused: "MISSING_FIELDS" }
  if (fields.some(([k]) => k === "slug")) return { refused: "SLUG_CHANGE" }
  if (fields.some(([k]) => !writable(collection, k))) return { refused: "FIELD_NOT_WRITABLE" }
  const after: Record<string, string> = {}, before: Record<string, string> = {}
  for (const [k, v] of fields) {
    const now = typeof item.fieldData[k] === "string" ? item.fieldData[k] as string : ""
    if (v.trim() !== now.trim()) { after[k] = v.trim(); before[k] = now }
  }
  return Object.keys(after).length ? { before: { fieldData: before }, after: { fieldData: after } } : { refused: "NOTHING_TO_CHANGE" }
}

export const slugify = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80)

/** A new item: a name, an address (from the name unless given), and every other required field, all text. */
export function planItemCreate(input: ChangeInput, collection: WfCollection): Plan {
  const given = Object.fromEntries(Object.entries(input.fields ?? {}).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v))
  if (!given["name"]) return { refused: "MISSING_FIELDS" }
  given["slug"] = slugify(given["slug"] || given["name"])
  if (!given["slug"]) return { refused: "MISSING_FIELDS" }
  if (Object.keys(given).some(k => !writable(collection, k))) return { refused: "FIELD_NOT_WRITABLE" }
  const missing = collection.fields.filter(f => f.required && !given[f.slug])
  if (missing.some(f => !TEXT_TYPES.has(f.type) && f.slug !== "name" && f.slug !== "slug")) return { refused: "COLLECTION_NEEDS_OTHER_FIELDS" }
  if (missing.length) return { refused: "MISSING_FIELDS" }
  return { before: {}, after: { fieldData: given } }
}

/** Rich text comes back reformatted (attributes, spacing); compare what a reader sees. */
const readable = (v: unknown) => (typeof v === "string" ? v : "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()

/** Whether Webflow stored exactly the approved values. */
export function storedPage(page: WfPage, after: WfValues): boolean {
  if (after.seo?.title !== undefined && page.seoTitle !== after.seo.title) return false
  if (after.seo?.description !== undefined && page.seoDescription !== after.seo.description) return false
  return true
}
export function storedItem(item: WfItem, after: WfValues, collection: WfCollection): boolean {
  for (const [k, v] of Object.entries(after.fieldData ?? {})) {
    const rich = collection.fields.find(f => f.slug === k)?.type === "RichText"
    if (rich ? readable(item.fieldData[k]) !== readable(v) : String(item.fieldData[k] ?? "").trim() !== v.trim()) return false
  }
  return true
}

/** Server-owned identity of a change request: the same change from the same person replays. */
export const changeKey = (parts: ReadonlyArray<unknown>) => createHash("sha256").update(JSON.stringify(parts)).digest("hex")
