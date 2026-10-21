// Provider failures as values with stable kinds. A Ga4Error never carries a
// token, an authorization code, a client secret or provider response text:
// only the HTTP status and Google's own status enum (for example
// PERMISSION_DENIED), so it is safe to log and to persist as an error code.
import { Data } from "effect"

export type Ga4ErrorKind =
  /** 401, or an OAuth `invalid_grant`: the authorization no longer works. */
  | "AUTH"
  /** 403: the identity cannot read this resource. */
  | "FORBIDDEN"
  | "NOT_FOUND"
  /** 429 or RESOURCE_EXHAUSTED: quota. Wait, never hammer. */
  | "QUOTA"
  /** 400: the request was refused as invalid. */
  | "INVALID"
  /** 5xx, timeout, connection failure. */
  | "UNAVAILABLE"
  /** A response OpenRecord cannot interpret safely. */
  | "UNEXPECTED"

export class Ga4Error extends Data.TaggedError("Ga4Error")<{
  readonly kind: Ga4ErrorKind
  readonly status: number | null
  /** Google's status enum or OAuth error code, never free text. */
  readonly providerCode: string | null
  readonly retryAfterSeconds: number | null
}> {
  override get message() { return `GA4 provider ${this.kind}${this.status === null ? "" : ` (${this.status})`}${this.providerCode ? ` ${this.providerCode}` : ""}` }
}

const SAFE_CODE = /^[A-Za-z_]{1,64}$/
export const safeProviderCode = (value: unknown): string | null => typeof value === "string" && SAFE_CODE.test(value) ? value : null

export const ga4ErrorFromStatus = (status: number, providerCode: string | null, retryAfterSeconds: number | null): Ga4Error => {
  const kind: Ga4ErrorKind = status === 401 ? "AUTH"
    : status === 403 && providerCode === "RESOURCE_EXHAUSTED" ? "QUOTA"
    : status === 403 ? "FORBIDDEN"
    : status === 404 ? "NOT_FOUND"
    : status === 429 ? "QUOTA"
    : status >= 500 ? "UNAVAILABLE"
    : status === 400 && providerCode === "invalid_grant" ? "AUTH"
    : status >= 400 && status < 500 ? "INVALID"
    : "UNEXPECTED"
  return new Ga4Error({ kind, status, providerCode, retryAfterSeconds })
}
