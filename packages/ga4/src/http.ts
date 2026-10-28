// The one place OpenRecord talks HTTP to Google. Redirects are refused (a
// credential is never sent anywhere but the configured endpoint), every call
// has a timeout and a response-size ceiling, and failures become Ga4Error
// values that carry no response text.
import { Ga4Error, ga4ErrorFromStatus, safeProviderCode } from "./errors.js"

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
const MAX_RESPONSE_BYTES = 4_000_000
const TIMEOUT_MS = 20_000

export interface Ga4Endpoints {
  readonly authorize: string
  readonly token: string
  readonly revoke: string
  readonly admin: string
  readonly data: string
  readonly searchConsole: string
}
export const GOOGLE_ENDPOINTS: Ga4Endpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  admin: "https://analyticsadmin.googleapis.com/v1beta",
  data: "https://analyticsdata.googleapis.com/v1beta",
  searchConsole: "https://www.googleapis.com/webmasters/v3",
}
/** A local stand-in (tests, runtime smoke) is accepted only on an exact loopback origin. */
export const standInEndpoints = (origin: string): Ga4Endpoints | null => {
  let url: URL
  try { url = new URL(origin) } catch { return null }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null
  const o = url.origin
  return { authorize: `${o}/o/oauth2/v2/auth`, token: `${o}/token`, revoke: `${o}/revoke`, admin: `${o}/admin/v1beta`, data: `${o}/data/v1beta`, searchConsole: `${o}/webmasters/v3` }
}

export interface HttpResult { readonly status: number; readonly text: string; readonly headers: Headers }

const retryAfter = (headers: Headers): number | null => {
  const raw = headers.get("retry-after")
  if (!raw) return null
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return Math.min(3600, Math.ceil(n))
  const at = Date.parse(raw)
  return Number.isNaN(at) ? null : Math.max(0, Math.min(3600, Math.ceil((at - Date.now()) / 1000)))
}

/** Google errors are `{error:{code,status}}` (APIs) or `{error:"invalid_grant"}` (OAuth). Only the enum is kept. */
const providerCodeOf = (text: string): string | null => {
  try {
    const body = JSON.parse(text) as { error?: unknown; status?: unknown }
    if (typeof body.error === "string") return safeProviderCode(body.error)
    if (body.error && typeof body.error === "object") return safeProviderCode((body.error as { status?: unknown }).status)
  } catch { /* not JSON */ }
  return null
}

export const send = async (fetchImpl: FetchLike, url: string, init: RequestInit): Promise<HttpResult> => {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Ga4Error({ kind: "UNAVAILABLE", status: null, providerCode: null, retryAfterSeconds: null })
  }
  let text: string
  try {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Ga4Error({ kind: "UNEXPECTED", status: response.status, providerCode: null, retryAfterSeconds: null })
    text = new TextDecoder("utf-8").decode(buffer)
  } catch (e) {
    if (e instanceof Ga4Error) throw e
    throw new Ga4Error({ kind: "UNAVAILABLE", status: response.status, providerCode: null, retryAfterSeconds: null })
  }
  if (response.status >= 300) throw ga4ErrorFromStatus(response.status, providerCodeOf(text), retryAfter(response.headers))
  return { status: response.status, text, headers: response.headers }
}

export const parseJson = (text: string): unknown => {
  try { return JSON.parse(text) } catch { throw new Ga4Error({ kind: "UNEXPECTED", status: null, providerCode: null, retryAfterSeconds: null }) }
}
export const unexpected = () => new Ga4Error({ kind: "UNEXPECTED", status: null, providerCode: null, retryAfterSeconds: null })
