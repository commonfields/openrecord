import { Context, Effect, Layer } from "effect"
import { SetupRepository, type DbEffect } from "@openrecord/db"
import type { DiscoverySignals } from "@openrecord/contracts"
import { safeFetch, type SafeFetchOptions } from "@openrecord/representation"
import { extractBusinessSignals } from "@openrecord/site-operator"

export class SetupRunner extends Context.Tag("SetupRunner")<SetupRunner, {
  /** `scope` limits the claim to one business (tests sharing one database). */
  readonly runOnce: (scope?: { readonly businessId?: string }) => DbEffect<boolean>
}>() {}

/** Reads the homepage an operator named, once, through the SSRF-safe fetcher.
 * The page is data: signals are stored for the operator to confirm and never
 * change what OpenRecord or the agent may do. */
export const makeSetupRunnerLive = (fetchOptions: SafeFetchOptions = {}) => Layer.effect(SetupRunner, Effect.gen(function*() {
  const setups = yield* SetupRepository
  return {
    runOnce: scope => Effect.gen(function*() {
      const claimed = yield* setups.claim(scope)
      if (!claimed) return false
      const evidence = yield* Effect.promise(() => safeFetch(claimed.websiteUrl, { ...fetchOptions,
        limits: { timeoutMs: 8000, maxBytes: 1_000_000, maxRedirects: 5, acceptedContentTypes: ["text/html"] } }))
      const ok = !evidence.failure && evidence.body !== null && evidence.status !== null && evidence.status >= 200 && evidence.status < 300
      if (!ok) {
        yield* setups.complete(claimed, { failure: evidence.failure ?? (evidence.status !== null ? `HTTP_${evidence.status}` : "UNREACHABLE") })
        return true
      }
      const finalUrl = evidence.finalUrl ?? claimed.websiteUrl
      let extracted: ReturnType<typeof extractBusinessSignals>
      try {
        extracted = extractBusinessSignals(new TextDecoder().decode(evidence.body!), finalUrl)
      } catch {
        // A page the extractor cannot handle is a recorded failure, never a stuck job.
        yield* setups.complete(claimed, { failure: "EXTRACTION_FAILED" })
        return true
      }
      const signals: DiscoverySignals = {
        version: 1,
        requestedUrl: claimed.websiteUrl,
        finalUrl,
        status: evidence.status,
        bodyDigest: evidence.bodyDigest ?? null,
        fetchedAt: new Date().toISOString(),
        ...extracted,
      }
      yield* setups.complete(claimed, { signals })
      return true
    }).pipe(Effect.catchTag("SetupRefused", () => Effect.succeed(false)), Effect.catchTag("GrowthRefused", () => Effect.succeed(false)), Effect.catchTag("RecordRefused", () => Effect.succeed(false))),
  }
}))
export const SetupRunnerLive = makeSetupRunnerLive()
