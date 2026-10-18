// Only prose is redacted: structured evidence and proposal receipts stay authoritative.
export interface ReplyInternals {
  readonly ids: Set<string>
  readonly fields: Set<string>
  readonly codes: Map<string, string>
}

export const replyInternals = (): ReplyInternals => ({ ids: new Set(), fields: new Set(), codes: new Map([
  ["REFERRAL_DATA_UNAVAILABLE", "referral data unavailable"], ["SIGNUPS_NOT_MEASURED", "signups not measured"],
  ["PROPOSED", "proposed"], ["APPROVED", "approved"], ["EXECUTED", "executed"], ["REJECTED", "rejected"],
]) })

export const collectReplyInternals = (value: unknown, internals: ReplyInternals): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectReplyInternals(item, internals)
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      internals.fields.add(key)
      if (/^ids?$/i.test(key) || /(?:_[iI][dD][sS]?|Id|Ids|ID|IDs)$/.test(key)) {
        for (const id of Array.isArray(item) ? item : [item]) {
          if (typeof id === "string" && id.trim()) internals.ids.add(id)
        }
      }
      if (/^(?:status|state|kind|code|reason|limitations?|missingRequirements|availability)$/i.test(key)) {
        for (const code of Array.isArray(item) ? item : [item]) {
          if (typeof code === "string" && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(code)) {
            internals.codes.set(code, code.toLowerCase().replaceAll("_", " "))
          }
        }
      }
      collectReplyInternals(item, internals)
    }
  }
}

const plainToolLanguage = (text: string, internals: ReplyInternals): string => {
  // Only backticked tool keys/values and known enum codes are rewritten. Ordinary
  // prose, counts and website quotations remain unchanged; empty annotations vanish.
  const inline = (fragment: string) => fragment.replace(/`([^`\n]+)`/g, (original: string, content: string) => {
    const field = /^\s*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s*:/.exec(content)?.[1]
    if (field && internals.fields.has(field)) return ""
    const code = internals.codes.get(content.trim())
    return code ?? original
  })
  return text.replace(/[ \t]*(\([^()\n]*`[^()\n]*\)|`[^`\n]+`)[ \t]*/g, (original: string, fragment: string, offset: number) => {
    const rewritten = inline(fragment)
    const clean = rewritten === fragment ? fragment : rewritten.replace(/\(\s*[,;]\s*/g, "(").replace(/\s*[,;]\s*\)/g, ")")
    if (clean === fragment) return original
    if (!clean.trim() || /^\([\s,;]*\)$/.test(clean)) {
      const before = text.slice(0, offset)
      const after = text.slice(offset + original.length)
      return before && after && !/^[.,!?;:)\]\n]/.test(after) && !/[\n(]$/.test(before) ? " " : ""
    }
    return original.replace(fragment, () => clean)
  })
}

export const sanitiseAgentReply = (text: string, internals: ReplyInternals): string => {
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"
  // Compact UUIDs are redacted when known from tools; arbitrary public asset hashes are not IDs.
  const values = [...internals.ids].flatMap(id => new RegExp(`^${uuid}$`, "i").test(id) ? [id, id.replaceAll("-", "")] : [id])
  const escaped = values.sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const known = escaped.length ? `|(?<![\\p{L}\\p{N}_])(?:\\{\\s*(?:${escaped.join("|")})\\s*\\}|${escaped.join("|")})(?![\\p{L}\\p{N}_])` : ""
  const identifier = new RegExp(`\\{\\s*${uuid}\\s*\\}|${uuid}${known}`, "giu")
  const containsId = (token: string) => {
    // Decode URL escapes for detection only; preserve ordinary quoted URLs verbatim.
    let decoded = token
    try { decoded = decodeURIComponent(token) } catch { /* malformed escapes still get the literal check */ }
    if (new RegExp(uuid, "i").test(decoded)) return true
    let reference = decoded
    try {
      const url = new URL(decoded)
      // A hostname can legitimately coincide with a short ID; IDs identify path/query/fragment data.
      reference = url.pathname + url.search + url.hash
    } catch { /* inspect the literal token if it cannot be parsed */ }
    identifier.lastIndex = 0
    return identifier.test(reference)
  }
  // Drop the whole internal URL, including UUID-bearing paths, rather than leave a broken link.
  const links = plainToolLanguage(text, internals).replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]*)\)/gi,
    (link: string, label: string, url: string) => containsId(url) ? label.trim() || "the referenced item" : link)
  // Match URLs before IDs so a legitimate URL is kept as a whole, never partly rewritten.
  return links.replace(new RegExp(`https?:\\/\\/[^\\s<>"\x60]+|${identifier.source}`, "giu"), token => {
    if (!/^https?:\/\//i.test(token)) return "the referenced item"
    return containsId(token) ? `the referenced item${token.match(/[.,!?;:)\]]+$/)?.[0] ?? ""}` : token
  })
}
