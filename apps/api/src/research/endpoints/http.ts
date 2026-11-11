// One call to a catalog endpoint. The host must be one of the provider's
// own; it is resolved once, every address must be public, and the
// connection is pinned to it. Redirects are not followed. The credential is
// added here and nowhere else, and anything echoed back is scrubbed of it.
import { isForbiddenIp, readCapped, defaultTransport, type HttpTransport } from "@openrecord/representation"
import { ACCOUNT_HOST, type Provider, type Request } from "./types.js"

export type CallFailure = "NOT_ALLOWED" | "NOT_PUBLIC" | "AUTH" | "FORBIDDEN" | "NOT_FOUND" | "RATE_LIMITED" | "REDIRECTED" | "INVALID_REQUEST" | "UNAVAILABLE" | "MALFORMED" | "NOT_CONFIGURED"
export type CallResult = { readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly failure: CallFailure; readonly retryAfterS: number | null }

const MAX_RESPONSE = 6_000_000
const fail = (failure: CallFailure, retryAfterS: number | null = null): CallResult => ({ ok: false, failure, retryAfterS })
export const hostAllowed = (provider: Provider, url: string) => {
  try {
    const u = new URL(url), host = u.hostname.toLowerCase()
    return u.protocol === "https:" && (provider.hosts.includes(host) || (provider.accountHost?.pattern.test(host) ?? false))
  } catch { return false }
}

/** Removes a credential from any text that might echo it (error bodies, next-page links). */
export const scrub = <T>(value: T, secrets: ReadonlyArray<string>): T => {
  const live = secrets.filter(s => s.length >= 6)
  if (!live.length) return value
  const json = JSON.stringify(value)
  let out = json
  for (const s of live) out = out.split(s).join("[credential removed]").split(encodeURIComponent(s)).join("[credential removed]")
  return out === json ? value : JSON.parse(out) as T
}

export interface Credentials { readonly secret: string | null; readonly bearer?: string | null }

/** Builds the final request: query, credential, required headers. */
export const prepare = (provider: Provider, req: Request, creds: Credentials, env: NodeJS.ProcessEnv) => {
  const url = new URL(req.url)
  // An API on the account's own host: the host comes from the credential.
  if (url.hostname === ACCOUNT_HOST) {
    const split = provider.accountHost && creds.secret ? provider.accountHost.split(creds.secret.trim()) : null
    if (!split || !provider.accountHost!.pattern.test(split.host.toLowerCase())) return { refused: "NOT_CONFIGURED" as const }
    url.hostname = split.host.toLowerCase()
    creds = { ...creds, secret: split.secret }
  }
  for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v))
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "OpenRecord-Research/1", ...(req.headers ?? {}) }
  const required = provider.headers ? provider.headers(env) : {}
  if (required === null) return { refused: "NOT_CONFIGURED" as const }
  Object.assign(headers, required)
  const a = provider.auth
  if (a.kind === "api_key" && creds.secret) { if (a.in === "query") url.searchParams.set(a.name, creds.secret); else headers[a.name.toLowerCase()] = `${a.prefix ?? ""}${creds.secret}` }
  if (a.kind === "api_key_pair" && creds.secret) {
    const at = creds.secret.indexOf(":")
    if (at <= 0) return { refused: "NOT_CONFIGURED" as const }
    url.searchParams.set(a.names[0], creds.secret.slice(0, at)); url.searchParams.set(a.names[1], creds.secret.slice(at + 1))
  }
  if (a.kind === "bearer" && creds.secret) headers["authorization"] = `Bearer ${creds.secret}`
  if (a.kind === "basic" && creds.secret) headers["authorization"] = `Basic ${Buffer.from(creds.secret).toString("base64")}`
  if ((a.kind === "client_credentials" || a.kind === "google_connection" || a.kind === "meta_connection") && creds.bearer) headers["authorization"] = `Bearer ${creds.bearer}`
  const body = req.body === undefined ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body)
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json"
  return { url: url.toString(), method: req.method, headers, ...(body !== undefined ? { body } : {}) }
}

export async function send(provider: Provider, prepared: { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  transport: HttpTransport = defaultTransport(25_000)): Promise<CallResult> {
  if (!hostAllowed(provider, prepared.url)) return fail("NOT_ALLOWED")
  const u = new URL(prepared.url)
  let addresses: string[]
  try { addresses = await transport.lookup(u.hostname) } catch { return fail("UNAVAILABLE") }
  if (!addresses.length || addresses.some(isForbiddenIp)) return fail("NOT_PUBLIC")
  let res
  try {
    res = await transport.fetch(prepared.url, { method: prepared.method, headers: prepared.headers, ...(prepared.body !== undefined ? { body: prepared.body } : {}),
      signal: AbortSignal.timeout(30_000), connectIp: addresses[0]!, servername: u.hostname })
  } catch { return fail("UNAVAILABLE") }
  const read = await readCapped(res.body, MAX_RESPONSE).catch(() => null)
  if (!read) return fail("UNAVAILABLE")
  const retry = Number(res.headers["retry-after"])
  const retryAfterS = Number.isFinite(retry) && retry >= 0 ? Math.min(Math.ceil(retry), 3600) : null
  if (res.status >= 300 && res.status < 400) return fail("REDIRECTED")
  if (res.status === 401) return fail("AUTH")
  if (res.status === 403) return fail("FORBIDDEN")
  if (res.status === 404) return fail("NOT_FOUND")
  if (res.status === 429) return fail("RATE_LIMITED", retryAfterS)
  if (res.status === 400 || res.status === 422) return fail("INVALID_REQUEST")
  if (res.status < 200 || res.status >= 300) return fail("UNAVAILABLE")
  if (read.truncated) return fail("MALFORMED")
  try { return { ok: true, json: JSON.parse(Buffer.from(read.bytes).toString("utf8")) } } catch { return fail("MALFORMED") }
}

/** Client credentials grant: exchanges "id:secret" for a short-lived token. */
export async function clientToken(provider: Provider, tokenUrl: string, secret: string, transport?: HttpTransport, scope?: string): Promise<string | null> {
  const [id, key] = secret.split(":")
  if (!id || !key) return null
  const r = await send({ ...provider, hosts: [...provider.hosts, new URL(tokenUrl).hostname] }, {
    url: tokenUrl, method: "POST", body: `grant_type=client_credentials${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "OpenRecord-Research/1", authorization: `Basic ${Buffer.from(`${id}:${key}`).toString("base64")}` },
  }, transport)
  const token = r.ok ? (r.json as { access_token?: unknown }).access_token : null
  return typeof token === "string" ? token : null
}
