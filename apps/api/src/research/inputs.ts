// Input schemas shared by research capabilities, and domain normalization.
import { Schema } from "effect"

/** A public hostname: lowercase, no scheme, www or path. Null when it is not one. */
export const normalizeDomain = (raw: string): string | null => {
  const s = raw.trim().toLowerCase()
  let host: string
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname } catch { return null }
  host = host.replace(/^www\./, "").replace(/\.$/, "")
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null
  if (/(^|\.)(localhost|local|internal|test|example|invalid|onion|lan|home|corp)$/.test(host)) return null
  return host
}
/** A public https page address on a public hostname, normalized; null otherwise. */
export const normalizeUrl = (raw: string): string | null => {
  const s = raw.trim()
  let u: URL
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`) } catch { return null }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || !normalizeDomain(u.hostname)) return null
  u.hash = ""
  return u.href
}

export const Domain = Schema.String.pipe(Schema.minLength(4), Schema.maxLength(253),
  Schema.filter(s => normalizeDomain(s) !== null, { message: () => "a public domain such as example.com", jsonSchema: { description: "Public domain such as example.com (scheme, www and path are ignored)" } }))
export const PageUrl = Schema.String.pipe(Schema.minLength(4), Schema.maxLength(2000),
  Schema.filter(s => normalizeUrl(s) !== null, { message: () => "a public web page address", jsonSchema: { description: "Public page address; a bare domain reads its home page" } }))
export const Limit = (min: number, max: number) => Schema.optional(Schema.Int.pipe(Schema.between(min, max)))
export const DomainInput = Schema.Struct({ domain: Domain })
