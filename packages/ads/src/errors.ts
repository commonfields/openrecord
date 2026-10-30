// Ad platform failures as values with stable kinds. An AdsError never carries
// a token, an authorization code, an app secret or response text: only the
// HTTP status and the platform's numeric or enum error code.
import { Data } from "effect"

export type AdsErrorKind = "AUTH" | "FORBIDDEN" | "NOT_FOUND" | "QUOTA" | "INVALID" | "UNAVAILABLE" | "UNEXPECTED"
export class AdsError extends Data.TaggedError("AdsError")<{
  readonly kind: AdsErrorKind
  readonly status: number | null
  readonly providerCode: string | null
}> {
  override get message() { return `Ad platform ${this.kind}${this.status === null ? "" : ` (${this.status})`}${this.providerCode ? ` ${this.providerCode}` : ""}` }
}
export const unexpected = () => new AdsError({ kind: "UNEXPECTED", status: null, providerCode: null })

// Meta Graph API error codes: 190 and 102 are an invalid or expired token;
// 4, 17, 32, 613 and 80004 are rate limits; 10 and 200-299 are permissions.
const metaKind = (code: number): AdsErrorKind | null =>
  code === 190 || code === 102 ? "AUTH" : [4, 17, 32, 613, 80000, 80004].includes(code) ? "QUOTA" : code === 10 || (code >= 200 && code < 300) ? "FORBIDDEN" : code === 100 ? "INVALID" : null

export const errorFromResponse = (status: number, text: string): AdsError => {
  let code: string | null = null, kind: AdsErrorKind | null = null
  try {
    const body = JSON.parse(text) as { error?: unknown }
    if (typeof body.error === "string") code = /^[a-z_]{1,64}$/.test(body.error) ? body.error : null
    else if (body.error && typeof body.error === "object") {
      const e = body.error as { code?: unknown; status?: unknown }
      if (typeof e.status === "string" && /^[A-Z_]{1,64}$/.test(e.status)) code = e.status
      else if (typeof e.code === "number" && Number.isInteger(e.code)) { code = String(e.code); kind = metaKind(e.code) }
    }
  } catch { /* not JSON */ }
  kind ??= status === 401 || code === "invalid_grant" || code === "UNAUTHENTICATED" ? "AUTH"
    : status === 429 || code === "RESOURCE_EXHAUSTED" ? "QUOTA"
    : status === 403 || code === "PERMISSION_DENIED" ? "FORBIDDEN"
    : status === 404 ? "NOT_FOUND"
    : status >= 500 ? "UNAVAILABLE"
    : status >= 400 ? "INVALID" : "UNEXPECTED"
  return new AdsError({ kind, status, providerCode: code })
}
