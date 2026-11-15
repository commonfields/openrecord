// What changed between two versions of an artifact, for a person reviewing
// the agent's edit: a summary (words added and removed, and each changed
// place with the heading it sits under), and the newer page with the change
// marked (added text highlighted, removed text struck through).
//
// Both versions are compared as their rendered documents (an HTML page as
// written, a Markdown piece as its reading page), split into tags and words.
// Tags take part in matching, so a moved or new section counts as changed,
// but only text is marked: a removed tag is dropped, never shown. The head
// (styles, title) is compared whole. A change too large to mark word by word
// (a rewrite) is reported as one.
export const DIFF_VERSION = "words-v1"

/** Above this many differing tokens the versions are treated as a rewrite. */
const MAX_EDIT = 4000

type Token = { readonly text: string; readonly tag: boolean }
type Op = { readonly kind: "same" | "add" | "del"; readonly token: Token }

const HEAD = /<head[\s>][\s\S]*?<\/head>/i

/** Tags, words and the spaces between them; the head stays one token. */
export const tokenize = (html: string): Token[] => {
  const tokens: Token[] = []
  const head = html.match(HEAD)
  let rest = html
  if (head && head.index !== undefined) {
    for (const t of split(html.slice(0, head.index))) tokens.push(t)
    tokens.push({ text: head[0], tag: true })
    rest = html.slice(head.index + head[0].length)
  }
  for (const t of split(rest)) tokens.push(t)
  return tokens
}
const split = (html: string): Token[] => [...html.matchAll(/<!--[\s\S]*?-->|<[^>]*>|[^<\s]+|\s+/g)].map(m => ({ text: m[0], tag: m[0].startsWith("<") }))

/** Myers' shortest edit script over token texts; null when it would exceed `max` differences. */
export const diffTokens = (a: ReadonlyArray<Token>, b: ReadonlyArray<Token>, max = MAX_EDIT): Op[] | null => {
  // Trim the shared start and end first: most edits touch a small middle.
  let start = 0
  while (start < a.length && start < b.length && a[start]!.text === b[start]!.text) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1]!.text === b[endB - 1]!.text) { endA--; endB-- }
  const A = a.slice(start, endA), B = b.slice(start, endB)
  const n = A.length, m = B.length, offset = max + 1
  const trace: Int32Array[] = []
  const v = new Int32Array(2 * max + 3)
  let found = -1
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && A[x]!.text === B[y]!.text) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break outer }
    }
  }
  if (found < 0) return null
  // Walk the trace back from the end to recover the script.
  const middle: Op[] = []
  let x = n, y = m
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!, k = x - y
    const prevK = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!) ? k + 1 : k - 1
    const prevX = prev[offset + prevK]!, prevY = prevX - prevK
    while (x > prevX && y > prevY) { middle.push({ kind: "same", token: A[--x]! }); y-- }
    if (x === prevX) middle.push({ kind: "add", token: B[--y]! })
    else middle.push({ kind: "del", token: A[--x]! })
  }
  while (x > 0 && y > 0) { middle.push({ kind: "same", token: A[--x]! }); y-- }
  middle.reverse()
  return [...a.slice(0, start).map(token => ({ kind: "same" as const, token })), ...middle, ...a.slice(endA).map(token => ({ kind: "same" as const, token }))]
}

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
const words = (ops: ReadonlyArray<Op>, kind: Op["kind"]) => ops.filter(o => o.kind === kind && !o.token.tag && o.token.text.trim()).length
const clip = (s: string, n = 160) => { const t = decode(s.replace(/\s+/g, " ").trim()); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

export interface ChangeSummary {
  readonly version: string
  /** True when the versions differ too much to mark word by word. */
  readonly rewritten: boolean
  readonly addedWords: number
  readonly removedWords: number
  /** Each changed place, in page order: the heading it sits under, what was there, what is there now. */
  readonly changes: ReadonlyArray<{ readonly near: string | null; readonly before: string; readonly after: string }>
}

const HEADING = /^<h[1-6][\s>]/i

/** The summary of what changed from `before` to `after` (rendered documents). */
export const summarize = (before: string, after: string, maxChanges = 20): ChangeSummary => {
  const ops = diffTokens(tokenize(before), tokenize(after))
  if (!ops) return { version: DIFF_VERSION, rewritten: true, addedWords: 0, removedWords: 0, changes: [] }
  const changes: Array<{ near: string | null; before: string; after: string }> = []
  let heading: string | null = null, inHeading = false, headingText = ""
  let hunk: { near: string | null; before: string; after: string } | null = null
  for (const o of ops) {
    if (o.token.tag && o.kind !== "del") {
      if (HEADING.test(o.token.text)) { inHeading = true; headingText = "" }
      else if (/^<\/h[1-6]>/i.test(o.token.text) && inHeading) { inHeading = false; heading = clip(headingText, 80) || heading }
    } else if (inHeading && o.kind !== "del") headingText += o.token.text
    if (o.kind === "same") {
      if (hunk && !o.token.tag && o.token.text.trim()) { changes.push(hunk); hunk = null }
      continue
    }
    if (o.token.tag) continue
    hunk ??= { near: heading, before: "", after: "" }
    if (o.kind === "del") hunk.before += o.token.text; else hunk.after += o.token.text
  }
  if (hunk) changes.push(hunk)
  const meaningful = changes.map(c => ({ near: c.near, before: clip(c.before), after: clip(c.after) })).filter(c => c.before || c.after)
  return { version: DIFF_VERSION, rewritten: false, addedWords: words(ops, "add"), removedWords: words(ops, "del"), changes: meaningful.slice(0, maxChanges) }
}

const MARK_STYLE = "<style>ins.or-change{background:#c9f2d4;color:inherit;text-decoration:none;border-radius:3px;box-shadow:0 0 0 1px #9fdcb1}del.or-change{background:#fbd5d3;color:#8a1c14;text-decoration:line-through;border-radius:3px}</style>"

/** The newer document with the change marked: added text in <ins>, removed text in <del>. Null when it is a rewrite. */
export const markChanges = (before: string, after: string): string | null => {
  const ops = diffTokens(tokenize(before), tokenize(after))
  if (!ops) return null
  let out = "", run: "add" | "del" | null = null
  const close = () => { if (run) out += run === "add" ? "</ins>" : "</del>"; run = null }
  for (const o of ops) {
    if (o.kind === "same" || o.token.tag) {
      // Tags and unchanged text close a marked run; a removed tag is dropped.
      if (o.kind === "del") continue
      if (o.kind === "same" || o.token.tag) close()
      out += HEAD.test(o.token.text) && o.token.tag ? o.token.text.replace(/<\/head>/i, `${MARK_STYLE}</head>`) : o.token.text
      continue
    }
    if (run !== o.kind) { close(); out += o.kind === "add" ? `<ins class="or-change">` : `<del class="or-change">`; run = o.kind }
    out += o.token.text
  }
  close()
  return /<\/head>/i.test(out) ? out : MARK_STYLE + out
}
