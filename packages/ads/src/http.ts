// The one place OpenRecord talks HTTP to ad platforms. Redirects are refused,
// every call has a timeout and a response-size ceiling, and failures become
// AdsError values without response text.
import { AdsError, errorFromResponse, unexpected } from "./errors.js"

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>
const MAX_RESPONSE_BYTES = 4_000_000
const TIMEOUT_MS = 20_000

export const send = async (fetchImpl: FetchLike, url: string, init: RequestInit = { method: "GET" }): Promise<unknown> => {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new AdsError({ kind: "UNAVAILABLE", status: null, providerCode: null })
  }
  let text: string
  try {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw unexpected()
    text = new TextDecoder("utf-8").decode(buffer)
  } catch (e) {
    if (e instanceof AdsError) throw e
    throw new AdsError({ kind: "UNAVAILABLE", status: response.status, providerCode: null })
  }
  if (response.status >= 300) throw errorFromResponse(response.status, text)
  try { return JSON.parse(text) } catch { throw unexpected() }
}

/** A non-negative number from a platform field that may be a number or a decimal string (int64 arrives as text). */
export const amount = (v: unknown): number => {
  if (v === undefined || v === null || v === "") return 0
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v) ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) throw unexpected()
  return n
}
export const text = (v: unknown, max = 300): string => typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : ""
