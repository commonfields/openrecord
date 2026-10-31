// Page edits for connected execution: the exact, deterministic change one
// HTML file receives, and the check that the live page shows it afterwards.
//
// Every edit is the smallest change that does the job: it replaces the one
// existing element, or inserts one into <head> when there is none. Values are
// escaped before they are written; a JSON-LD block cannot close its script
// tag. Whenever the page is ambiguous (no single <head>, two <title> tags,
// two canonical links, an image that appears twice), the edit returns null
// and the change is refused, never guessed. The copy itself (a title, a
// description, alt text, structured data) is proposed by the agent or a
// person and reaches the site only through the reviewed, authorized pull
// request, so nothing here publishes on its own.
import { removeNoindexFromHtml } from "./fixes.js"

export type PageEdit =
  | { readonly kind: "REMOVE_NOINDEX_META" }
  | { readonly kind: "SET_TITLE"; readonly title: string }
  | { readonly kind: "SET_META_DESCRIPTION"; readonly description: string }
  | { readonly kind: "SET_CANONICAL"; readonly url: string }
  | { readonly kind: "ADD_JSON_LD"; readonly json: string }
  | { readonly kind: "SET_IMAGE_ALT"; readonly src: string; readonly alt: string }

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;")
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
const norm = (s: string) => decode(s).replace(/\s+/g, " ").trim()

/** The page's single <head> element: where it opens, where its content ends. */
const headOf = (html: string) => {
  const opens = [...html.matchAll(/<head(?:\s[^>]*)?>/gi)], closes = [...html.matchAll(/<\/head\s*>/gi)]
  if (opens.length !== 1 || closes.length !== 1) return null
  const start = opens[0]!.index! + opens[0]![0].length, end = closes[0]!.index!
  return end >= start ? { start, end, inner: html.slice(start, end) } : null
}
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null
}
/** The tags of one element type in <head> whose attribute has a value. */
const headTags = (inner: string, element: string, name: string, value: string) =>
  [...inner.matchAll(new RegExp(`<${element}\\b[^>]*>`, "gi"))].filter(m => (attr(m[0], name) ?? "").toLowerCase().split(/\s+/).includes(value))
/** Inserts a line just before </head>, matching the indentation of the head's last element. */
const insertInHead = (html: string, head: { start: number; end: number; inner: string }, line: string) => {
  const indent = head.inner.match(/\n([ \t]*)\S[^\n]*\s*$/)?.[1] ?? "  "
  const upToClose = html.slice(0, head.end)
  const closeIndent = upToClose.match(/[ \t]*$/)![0], before = upToClose.slice(0, upToClose.length - closeIndent.length)
  const sep = before.endsWith("\n") ? "" : "\n"
  return `${before}${sep}${indent}${line}\n${closeIndent}${html.slice(head.end)}`
}
const replaceAt = (html: string, offset: number, length: number, text: string) => html.slice(0, offset) + text + html.slice(offset + length)

/** The JSON-LD a page edit may add: schema.org objects only, as stable JSON. */
export const jsonLdBlock = (json: string): string | null => {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return null }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  if (!items.length || !items.every(i => i !== null && typeof i === "object" && !Array.isArray(i) && /schema\.org/i.test(String((i as Record<string, unknown>)["@context"] ?? "")))) return null
  // "</" inside a string could close the script element; JSON allows the escaped form.
  return JSON.stringify(parsed, null, 2).replace(/<\//g, "<\\/")
}
const jsonLdScripts = (html: string) => [...html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
const sameJson = (a: string, b: string) => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) } catch { return false } }

/** The edited page, or null when the edit cannot be made safely or changes nothing. */
export const applyPageEdit = (html: string, edit: PageEdit): string | null => {
  const done = (after: string | null) => after !== null && after !== html ? after : null
  if (edit.kind === "REMOVE_NOINDEX_META") return done(removeNoindexFromHtml(html))
  if (edit.kind === "SET_IMAGE_ALT") {
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].filter(m => attr(m[0], "src") === edit.src)
    if (imgs.length !== 1) return null
    const tag = imgs[0]![0], value = `alt="${escapeAttr(edit.alt)}"`
    const next = attr(tag, "alt") !== null
      ? tag.replace(/\salt\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` ${value}`)
      : tag.replace(/^<img\b/i, `<img ${value}`)
    return done(replaceAt(html, imgs[0]!.index!, tag.length, next))
  }
  const head = headOf(html)
  if (!head) return null
  if (edit.kind === "SET_TITLE") {
    const titles = [...head.inner.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)]
    if (titles.length > 1) return null
    const tag = `<title>${escapeText(edit.title)}</title>`
    if (!titles.length) return done(insertInHead(html, head, tag))
    return done(replaceAt(html, head.start + titles[0]!.index!, titles[0]![0].length, tag))
  }
  if (edit.kind === "SET_META_DESCRIPTION") {
    const metas = headTags(head.inner, "meta", "name", "description")
    if (metas.length > 1) return null
    const tag = `<meta name="description" content="${escapeAttr(edit.description)}">`
    if (!metas.length) return done(insertInHead(html, head, tag))
    return done(replaceAt(html, head.start + metas[0]!.index!, metas[0]![0].length, tag))
  }
  if (edit.kind === "SET_CANONICAL") {
    const links = headTags(head.inner, "link", "rel", "canonical")
    if (links.length > 1) return null
    const tag = `<link rel="canonical" href="${escapeAttr(edit.url)}">`
    if (!links.length) return done(insertInHead(html, head, tag))
    return done(replaceAt(html, head.start + links[0]!.index!, links[0]![0].length, tag))
  }
  const block = jsonLdBlock(edit.json)
  if (!block || jsonLdScripts(html).some(m => sameJson(m[1] ?? "", edit.json))) return null
  return done(insertInHead(html, head, `<script type="application/ld+json">\n${block}\n</script>`))
}

/** Whether a live page shows the edit. Noindex is checked by the page inspector instead. */
export const pageEditObserved = (html: string, edit: Exclude<PageEdit, { kind: "REMOVE_NOINDEX_META" }>): boolean => {
  if (edit.kind === "SET_IMAGE_ALT")
    return [...html.matchAll(/<img\b[^>]*>/gi)].some(m => attr(m[0], "src") === edit.src && norm(attr(m[0], "alt") ?? "") === norm(edit.alt))
  if (edit.kind === "ADD_JSON_LD") return jsonLdScripts(html).some(m => sameJson(m[1] ?? "", edit.json))
  const head = headOf(html)
  if (!head) return false
  if (edit.kind === "SET_TITLE") {
    const titles = [...head.inner.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/gi)]
    return titles.length === 1 && norm(titles[0]![1] ?? "") === norm(edit.title)
  }
  if (edit.kind === "SET_META_DESCRIPTION") {
    const metas = headTags(head.inner, "meta", "name", "description")
    return metas.length === 1 && norm(attr(metas[0]![0], "content") ?? "") === norm(edit.description)
  }
  const links = headTags(head.inner, "link", "rel", "canonical")
  return links.length === 1 && decode(attr(links[0]![0], "href") ?? "") === edit.url
}

/** How the live check describes each edit, for the operation's history. */
export const pageEditLabel = (edit: PageEdit): string => ({
  REMOVE_NOINDEX_META: "the noindex directive removed",
  SET_TITLE: "the new page title",
  SET_META_DESCRIPTION: "the new meta description",
  SET_CANONICAL: "the new canonical address",
  ADD_JSON_LD: "the added structured data",
  SET_IMAGE_ALT: "the new image alt text",
})[edit.kind]
