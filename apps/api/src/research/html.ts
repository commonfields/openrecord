// Small, deterministic HTML readers for research: links, scripts, meta tags,
// JSON-LD blocks, readable text, dates and money amounts. They read markup as
// data and never run it. Third-party text is cleaned and shortened before it
// leaves this module.

/** Third-party text: control and bidi-override characters removed, whitespace collapsed, shortened. */
export const clean = (v: unknown, max = 200): string | null =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"" }
export const decodeEntities = (s: string) => s
  .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => { const n = parseInt(h, 16); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " " })
  .replace(/&#(\d{1,7});/g, (_m, d: string) => { const n = Number(d); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " " })
  .replace(/&([a-z0-9#]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : null
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()

/** The document without scripts, styles, templates and comments. */
const visible = (html: string) => html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")

export interface Link { readonly href: string; readonly text: string; readonly rel: string | null }
export const links = (html: string, base: string): Link[] => {
  const out: Link[] = []
  for (const m of visible(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[0]!, "href")
    if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) continue
    try { out.push({ href: new URL(href, base).href, text: clean(stripTags(m[2] ?? ""), 120) ?? clean(attr(m[2] ?? "", "alt"), 120) ?? "", rel: attr(m[0]!, "rel") }) } catch { /* not a URL */ }
    if (out.length >= 2000) break
  }
  return out
}
export const linkTags = (html: string, base: string) => [...html.matchAll(/<link\b[^>]*>/gi)].flatMap(m => {
  const href = attr(m[0], "href")
  if (!href) return []
  try { return [{ href: new URL(href, base).href, rel: (attr(m[0], "rel") ?? "").toLowerCase(), type: (attr(m[0], "type") ?? "").toLowerCase() }] } catch { return [] }
})
export const scriptSources = (html: string, base: string) => [...html.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/gi)].flatMap(m => { try { return [new URL(decodeEntities(m[1]!), base).href] } catch { return [] } })
export const inlineScripts = (html: string) => [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1] ?? "").join("\n").slice(0, 400_000)
export const metaContent = (html: string, key: string): string | null => {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const k = (attr(m[0], "name") ?? attr(m[0], "property") ?? attr(m[0], "itemprop") ?? "").toLowerCase()
    if (k === key.toLowerCase()) return clean(attr(m[0], "content"), 400)
  }
  return null
}
export const title = (html: string) => clean(stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""), 200)
export const headings = (html: string, levels = [1, 2, 3]) => [...visible(html).matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
  .filter(m => levels.includes(Number(m[1]))).map(m => ({ level: Number(m[1]), text: clean(stripTags(m[2] ?? ""), 160) ?? "" })).filter(h => h.text).slice(0, 80)
export const text = (html: string, max = 20_000) => clean(stripTags(visible(html).replace(/<(br|p|div|li|h[1-6]|tr|section|article)\b[^>]*>/gi, "\n")), max) ?? ""
/** Sentence-ish lines of visible text, for comparing two versions of a page. */
export const lines = (html: string) => decodeEntities(visible(html)
  .replace(/<\/?(br|p|div|li|h[1-6]|tr|td|section|article|header|footer|nav|ul|ol|table)\b[^>]*>/gi, "\u0001").replace(/<[^>]*>/g, " "))
  .split(/[\u0001\n]|(?<=[.!?])\s+(?=[A-Z])/).map(s => s.replace(/\s+/g, " ").trim()).filter(s => s.length >= 3 && s.length <= 400)

/** Every JSON-LD object on the page, @graph flattened. Invalid blocks are skipped. */
export const jsonLd = (html: string): Array<Record<string, unknown>> => {
  const out: Array<Record<string, unknown>> = []
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(m[1]!.trim())
      const visit = (v: unknown) => {
        if (Array.isArray(v)) { v.forEach(visit); return }
        if (v && typeof v === "object") {
          const o = v as Record<string, unknown>
          if (Array.isArray(o["@graph"])) (o["@graph"] as unknown[]).forEach(visit)
          if (o["@type"]) out.push(o)
        }
      }
      visit(parsed)
    } catch { /* invalid JSON-LD is skipped */ }
    if (out.length > 100) break
  }
  return out
}
export const typesOf = (o: Record<string, unknown>) => (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).map(String)

export interface Money { readonly amount: number; readonly currency: string; readonly period: string | null; readonly context: string }
const CURRENCY: Readonly<Record<string, string>> = { "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "Rp": "IDR", "RM": "MYR", "S$": "SGD", "A$": "AUD", "C$": "CAD", "R$": "BRL" }
/** Prices written on a page: amount, currency, billing period when stated, and the words around them. */
export const money = (pageText: string): Money[] => {
  const out: Money[] = []
  const re = /(US\$|S\$|A\$|C\$|R\$|Rp|RM|[$€£¥₹])\s?(\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:\/|per\s)?\s*(mo(?:nth)?|month|yr|year|annum|user|seat|week|day)?/gi
  for (const m of pageText.matchAll(re)) {
    const raw = m[2]!.replace(/\s/g, "")
    const normalized = /[.,]\d{1,2}$/.test(raw) ? raw.replace(/[.,](?=\d{3})/g, "").replace(",", ".") : raw.replace(/[.,]/g, "")
    const amount = Number(normalized)
    if (!Number.isFinite(amount)) continue
    const at = m.index ?? 0
    out.push({ amount, currency: CURRENCY[m[1]!] ?? m[1]!, period: m[3] ? m[3].toLowerCase().replace(/^mo(nth)?$/, "month").replace(/^yr|annum$/, "year") : null,
      context: clean(pageText.slice(Math.max(0, at - 60), at + 60), 140) ?? "" })
    if (out.length >= 60) break
  }
  return out
}

/** A date in common feed and page formats, as an ISO string; null when it cannot be read. */
export const isoDate = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !raw.trim()) return null
  const t = Date.parse(raw.trim())
  return Number.isFinite(t) && t > Date.UTC(1995, 0, 1) && t < Date.now() + 86_400_000 * 2 ? new Date(t).toISOString() : null
}
export const month = (iso: string) => iso.slice(0, 7)

/** Hostname without www, lowercase. */
export const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, "") } catch { return null } }
export const sameSite = (url: string, domain: string) => { const h = hostOf(url); return h !== null && (h === domain || h.endsWith(`.${domain}`)) }

const STOP = new Set("a an and are as at be by for from has have how i in is it its of on or our that the this to was we what when where which who why will with you your can get more all new best top free not no do does vs".split(" "))
/** The phrases a set of texts repeats, one to three words, weighted by where they appear. */
export const phrases = (weighted: ReadonlyArray<{ readonly text: string; readonly weight: number }>, limit = 25) => {
  const score = new Map<string, number>()
  for (const { text: t, weight } of weighted) {
    const words = t.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter(w => w.length > 1)
    const seen = new Set<string>()
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) {
      const gram = words.slice(i, i + n)
      if (STOP.has(gram[0]!) || STOP.has(gram[gram.length - 1]!) || gram.every(w => /^\d+$/.test(w))) continue
      const key = gram.join(" ")
      if (seen.has(key)) continue
      seen.add(key)
      score.set(key, (score.get(key) ?? 0) + weight * n)
    }
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([phrase, s]) => ({ phrase, score: Math.round(s * 10) / 10 }))
}
