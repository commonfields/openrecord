// A page as the agent reads it: main text, outline and the signals search
// engines and AI assistants read from raw HTML. Pure and deterministic: no
// network, no LLM. The page is untrusted data; nothing here interprets it.
import { load } from "cheerio"

export interface ReadablePage {
  readonly title: string | null
  readonly description: string | null
  readonly canonical: string | null
  readonly lang: string | null
  readonly robotsMeta: string | null
  /** h1 to h3 in document order, at most 40. */
  readonly headings: ReadonlyArray<{ readonly level: number; readonly text: string }>
  /** Main content as plain text, whitespace collapsed, cut at `maxChars`. */
  readonly text: string
  readonly truncated: boolean
  readonly wordCount: number
  readonly h1Count: number
  /** Same-host absolute links without fragments, at most 200. */
  readonly internalLinks: ReadonlyArray<string>
  readonly externalLinkCount: number
  /** schema.org @type values found in valid JSON-LD blocks. */
  readonly structuredDataTypes: ReadonlyArray<string>
  readonly invalidStructuredData: number
  readonly openGraph: boolean
  /** Headings phrased as a question, which answer engines can lift directly. */
  readonly questionHeadings: number
  readonly lists: number
  readonly tables: number
  readonly images: number
  readonly imagesMissingAlt: number
  readonly published: string | null
  readonly modified: string | null
  readonly author: string | null
}

const clean = (s: string | undefined | null) => {
  const v = (s ?? "").replace(/\s+/g, " ").trim()
  return v === "" ? null : v
}

const typesOf = (node: unknown, out: Set<string>, depth = 0): void => {
  if (depth > 8 || node === null || typeof node !== "object") return
  if (Array.isArray(node)) { for (const n of node) typesOf(n, out, depth + 1); return }
  const t = (node as Record<string, unknown>)["@type"]
  for (const v of Array.isArray(t) ? t : [t]) if (typeof v === "string" && v.length <= 80) out.add(v)
  const graph = (node as Record<string, unknown>)["@graph"]
  if (graph !== undefined) typesOf(graph, out, depth + 1)
}

export const readablePage = (html: string, finalUrl: string, opts: { readonly maxChars?: number } = {}): ReadablePage => {
  const maxChars = opts.maxChars ?? 12_000
  const $ = load(html)
  const base = (() => { try { return new URL(finalUrl) } catch { return null } })()

  const types = new Set<string>()
  let invalidStructuredData = 0
  $('script[type="application/ld+json"]').each((_, el) => {
    try { typesOf(JSON.parse($(el).text()), types) } catch { invalidStructuredData += 1 }
  })

  const internal = new Set<string>()
  let externalLinkCount = 0
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? ""
    if (!base || /^(mailto:|tel:|javascript:|#)/i.test(href)) return
    try {
      const u = new URL(href, base)
      if (u.protocol !== "http:" && u.protocol !== "https:") return
      u.hash = ""
      if (u.hostname === base.hostname) { if (internal.size < 200) internal.add(u.toString()) } else externalLinkCount += 1
    } catch { /* not a link */ }
  })

  const images = $("img")
  const imagesMissingAlt = images.filter((_, el) => $(el).attr("alt") === undefined).length
  const meta = (sel: string) => clean($(sel).first().attr("content"))
  const timeAttr = clean($("time[datetime]").first().attr("datetime"))

  const headings: Array<{ level: number; text: string }> = []
  let questionHeadings = 0
  $("h1, h2, h3, h4").each((_, el) => {
    const text = clean($(el).text())
    if (!text) return
    if (/\?$/.test(text)) questionHeadings += 1
    const level = Number(el.tagName.slice(1))
    if (level <= 3 && headings.length < 40) headings.push({ level, text: text.slice(0, 200) })
  })
  const lists = $("ul, ol").length
  const tables = $("table").length

  $("script, style, noscript, template, svg, iframe, canvas").remove()
  const main = $("main, article, [role=main]").first()
  const root = main.length ? main : $("body")
  // Block elements become line breaks so the text keeps its paragraphs.
  root.find("p, li, h1, h2, h3, h4, h5, h6, tr, br, div, section").each((_, el) => { $(el).append("\n") })
  const full = root.text().split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
  const wordCount = full.split(/\s+/).filter(Boolean).length

  return {
    title: clean($("title").first().text()),
    description: meta('meta[name="description"]'),
    canonical: clean($('link[rel="canonical"]').first().attr("href")),
    lang: clean($("html").attr("lang")),
    robotsMeta: meta('meta[name="robots"]'),
    headings,
    text: full.slice(0, maxChars),
    truncated: full.length > maxChars,
    wordCount,
    h1Count: $("h1").length,
    internalLinks: [...internal],
    externalLinkCount,
    structuredDataTypes: [...types].sort(),
    invalidStructuredData,
    openGraph: $('meta[property^="og:"]').length > 0,
    questionHeadings,
    lists,
    tables,
    images: images.length,
    imagesMissingAlt,
    published: meta('meta[property="article:published_time"]') ?? timeAttr,
    modified: meta('meta[property="article:modified_time"]') ?? meta('meta[property="og:updated_time"]'),
    author: meta('meta[name="author"]') ?? meta('meta[property="article:author"]'),
  }
}
