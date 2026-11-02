// Shared shapes for OpenRecord's research capabilities.
import type { Effect, Schema } from "effect"
import type { SqlClient } from "@effect/sql"
import type { ResearchNetService } from "./net.js"

/** SEEN: listed or published on a date. ESTIMATED: a model's or provider's number. INFERRED: OpenRecord's reading of seen evidence. */
export type Label = "SEEN" | "ESTIMATED" | "INFERRED"
export type Source = "PUBLIC_WEB" | "PUBLIC_ARCHIVE" | "PUBLIC_REGISTRY" | "PUBLIC_FEED" | "PUBLIC_API" | "OPENRECORD_SNAPSHOT" | "CONNECTED_ACCOUNT" | "AI_SUBSCRIPTION" | "TEAM_UPLOAD" | "DERIVED"

/** One dated event a capability saw, for the cross-source timeline. */
export interface TimelineEvent { readonly date: string; readonly event: string; readonly label: Label; readonly url?: string | null }
export interface Citation { readonly kind: string; readonly id: string; readonly text: string }

export interface Observed {
  readonly status: "OBSERVED" | "NO_DATA"
  readonly findings: Record<string, unknown>
  readonly coverage: Record<string, unknown>
  readonly citations?: ReadonlyArray<Citation>
  readonly timeline?: ReadonlyArray<TimelineEvent>
}
/** A capability that could not run: a stable reason and what the agent should do instead. */
export interface Refused { readonly refused: string; readonly message: string; readonly detail?: Record<string, unknown> }
export const refuse = (refused: string, message: string, detail?: Record<string, unknown>): Refused => ({ refused, message, ...(detail ? { detail } : {}) })
export const isRefused = (r: Observed | Refused): r is Refused => "refused" in r

export interface RunContext {
  readonly accountId: string; readonly userId: string; readonly businessId: string
  readonly net: ResearchNetService
  readonly now: Date
}

export interface Capability<I = unknown> {
  readonly id: string
  readonly platform: string
  readonly title: string
  /** What it returns and its limits, in plain words, for the model. */
  readonly description: string
  readonly source: Source
  readonly label: Label
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly input: Schema.Schema<I, any, never>
  /** "day": the same input on the same UTC day reuses the saved observation. "none": always runs (derived reports, uploads). */
  readonly cache: "day" | "none"
  readonly subject: (input: I) => string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly run: (ctx: RunContext, input: I) => Effect.Effect<Observed | Refused, unknown, SqlClient.SqlClient | any>
  /** Why it cannot run on this server for this business right now; null when it can. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly availability?: (ctx: Omit<RunContext, "net" | "now">) => Effect.Effect<string | null, unknown, SqlClient.SqlClient | any>
  /** Capabilities sharing a key share one availability (for example every endpoint of one provider). */
  readonly availabilityKey?: string
}
/** A capability with its input type erased, for lists of mixed capabilities. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapability = Capability<any>
