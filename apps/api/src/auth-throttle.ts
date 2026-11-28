// Brute-force protection for sign-in and sign-up.
//
// Fixed windows counted in memory. The API runs as a single process behind
// the reverse proxy (deploy/hosted-pilot.compose.yaml), so one table is the
// whole picture; a restart forgets the counts, which only ever errs toward
// letting a person back in. A deployment with several API processes needs a
// shared store instead.
//
// Three limits:
//   - attempts per client address (sign-in), so one machine cannot sweep many accounts;
//   - failed sign-ins per email, so a distributed guesser cannot hammer one account;
//   - sign-ups per client address, so one machine cannot mint accounts in bulk.
import { HttpServerRequest } from "@effect/platform"
import { Effect, Option } from "effect"

export interface Limit { readonly max: number; readonly windowMs: number }

export const LIMITS = {
  signinPerAddress: { max: 30, windowMs: 15 * 60_000 },
  failuresPerEmail: { max: 8, windowMs: 15 * 60_000 },
  signupPerAddress: { max: 10, windowMs: 60 * 60_000 },
} as const satisfies Record<string, Limit>

interface Window { count: number; resetAt: number }

const SWEEP_AT = 10_000

export class Throttle {
  private readonly windows = new Map<string, Window>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds until `key` may try again, or 0 when it is under `limit`. Does not count. */
  blockedFor(key: string, limit: Limit): number {
    const w = this.live(key)
    return w && w.count >= limit.max ? w.resetAt - this.now() : 0
  }

  /** Counts one attempt against `key`. */
  hit(key: string, limit: Limit): void {
    const w = this.live(key)
    if (w) w.count++
    else {
      if (this.windows.size >= SWEEP_AT) this.sweep()
      this.windows.set(key, { count: 1, resetAt: this.now() + limit.windowMs })
    }
  }

  clear(key: string): void {
    this.windows.delete(key)
  }

  private live(key: string): Window | undefined {
    const w = this.windows.get(key)
    if (w && w.resetAt <= this.now()) {
      this.windows.delete(key)
      return undefined
    }
    return w
  }

  private sweep(): void {
    const now = this.now()
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k)
  }
}

export const authThrottle = new Throttle()

/**
 * The address the request came from. Behind the bundled reverse proxy
 * (TRUST_PROXY=1) that is the last X-Forwarded-For entry, the one the proxy
 * itself appended; earlier entries are whatever the client claimed. Without
 * a trusted proxy the header is ignored, so it cannot be used to dodge limits.
 */
export const clientAddress = Effect.map(HttpServerRequest.HttpServerRequest, (req) => {
  if (process.env["TRUST_PROXY"] === "1") {
    const forwarded = req.headers["x-forwarded-for"]?.split(",").map(s => s.trim()).filter(Boolean)
    const last = forwarded?.[forwarded.length - 1]
    if (last) return last
  }
  return Option.getOrElse(req.remoteAddress, () => "unknown")
})

export const retryAfterSeconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)))
