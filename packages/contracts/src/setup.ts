import { Schema } from "effect"
import { GrowthConversionKind, GrowthTimeZone, GrowthUrl, type GrowthOpportunity } from "./growth.js"

const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter(s => s.trim().length > 0))

/** Where a business is in onboarding. Derived from stored state, never stored. */
export const SetupStep = Schema.Literal("DISCOVER", "CONFIRM", "CONNECT", "PROPOSE", "DONE")
export type SetupStep = typeof SetupStep.Type

export const SetupStartInput = Schema.Struct({
  websiteUrl: GrowthUrl,
  goalStatement: Schema.optionalWith(Schema.NullOr(Text(1000)), { default: () => null }),
  /** Set up an existing business instead of creating one. */
  businessId: Schema.optionalWith(Schema.NullOr(Schema.UUID), { default: () => null }),
})
export type SetupStartInput = typeof SetupStartInput.Type

/** A public channel identity read from the homepage. Discovery only: no account access. */
export const DiscoveredChannelKind = Schema.Literal("LINKEDIN", "X", "FACEBOOK", "INSTAGRAM", "YOUTUBE", "TIKTOK", "PINTEREST", "GITHUB", "GOOGLE_BUSINESS", "YELP", "G2", "CAPTERRA", "PRODUCT_HUNT", "EMAIL")
export type DiscoveredChannelKind = typeof DiscoveredChannelKind.Type

/** Signals read from one public page. Untrusted data: every string is shown
 * to the operator as a suggestion and is never authority. */
export interface DiscoverySignals {
  readonly version: 1
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly status: number | null
  readonly bodyDigest: string | null
  readonly fetchedAt: string
  readonly siteName: string | null
  readonly title: string | null
  readonly description: string | null
  readonly headings: ReadonlyArray<string>
  readonly pages: ReadonlyArray<{ readonly url: string; readonly label: string }>
  readonly channels: ReadonlyArray<{ readonly kind: DiscoveredChannelKind; readonly url: string }>
  readonly organization: { readonly name: string | null; readonly telephone: string | null; readonly email: string | null } | null
  readonly checks: {
    readonly hasTitle: boolean
    readonly hasDescription: boolean
    readonly hasCanonical: boolean
    readonly hasOrganizationData: boolean
    readonly h1Count: number
    readonly noindex: boolean
  }
}

/** What the operator confirms. Facts are the only part that becomes
 * authoritative; each one is a deliberate human choice. */
export const SetupFactInput = Schema.Struct({ predicate: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]{1,59}$/)), valueText: Text(500) })
export const SetupConfirmInput = Schema.Struct({
  expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  businessName: Text(200),
  category: Text(300),
  audience: Text(1000),
  valueProposition: Text(2000),
  goalStatement: Text(1000),
  conversionKind: GrowthConversionKind,
  metricLabel: Text(120),
  reportingTimeZone: GrowthTimeZone,
  facts: Schema.Array(SetupFactInput).pipe(Schema.maxItems(8)),
})
export type SetupConfirmInput = typeof SetupConfirmInput.Type
export const SetupRevisionInput = Schema.Struct({ expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)) })
export type SetupRevisionInput = typeof SetupRevisionInput.Type

export interface SetupBrief {
  readonly businessName: string
  readonly category: string
  readonly audience: string
  readonly valueProposition: string
  readonly goalStatement: string
  readonly conversionKind: typeof GrowthConversionKind.Type
  readonly metricLabel: string
  readonly reportingTimeZone: string
  readonly factIds: ReadonlyArray<string>
}

/* ------------------------------------------------------------- channels */

/** What a provider can actually do once connected. Never inferred from a
 * ledger channel name. */
export const ChannelCapability = Schema.Literal("DISCOVER", "READ", "PROPOSE", "EXECUTE", "VERIFY", "MEASURE")
export type ChannelCapability = typeof ChannelCapability.Type
export const ChannelState = Schema.Literal("DISCOVERED", "CONNECTED", "PERMISSION_REQUIRED", "UNSUPPORTED", "REVOKED", "UNHEALTHY")
export type ChannelState = typeof ChannelState.Type

export interface ChannelEntry {
  readonly key: string
  readonly label: string
  /** The account, page or profile this entry is about, when known. */
  readonly identity: string | null
  readonly state: ChannelState
  /** Capabilities usable right now. */
  readonly active: ReadonlyArray<ChannelCapability>
  /** Capabilities this integration implements once connected. Empty for an
   * unsupported channel. */
  readonly offered: ReadonlyArray<ChannelCapability>
  readonly note: string
  readonly action: { readonly kind: "CONNECT_GA4" | "OPEN"; readonly label: string; readonly href: string } | null
}

export interface ChannelInventory {
  readonly channels: ReadonlyArray<ChannelEntry>
  /** OpenRecord's own instruments. Not the business's accounts, so never "connected". */
  readonly builtIn: ReadonlyArray<{ readonly key: string; readonly label: string; readonly available: boolean; readonly note: string; readonly action: ChannelEntry["action"] }>
  /** Always available without any integration. */
  readonly manual: ReadonlyArray<{ readonly key: string; readonly label: string; readonly note: string }>
}

/* --------------------------------------------------------------- setup */

export interface SetupAssessment {
  readonly findings: ReadonlyArray<{ readonly key: string; readonly tone: "gap" | "ok" | "unknown"; readonly text: string }>
  readonly measurement: "CONNECTED" | "MANUAL_ONLY" | "NONE"
}

/** What the agent drafted from the website for the person to check. A suggestion, never authority. */
export const SetupDraft = Schema.Struct({
  businessName: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  category: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)),
  audience: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
  valueProposition: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
  goalStatement: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)),
  conversionKind: GrowthConversionKind,
  metricLabel: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)),
  competitors: Schema.Array(Schema.Struct({ name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)), website: Schema.optional(Schema.String.pipe(Schema.maxLength(300))) })).pipe(Schema.maxItems(8)),
})
export type SetupDraft = typeof SetupDraft.Type

export interface SetupView {
  readonly id: string
  readonly businessId: string
  readonly businessName: string
  readonly websiteUrl: string
  readonly goalStatement: string | null
  readonly step: SetupStep
  readonly revision: number
  readonly discovery:
    | { readonly status: "QUEUED" | "FETCHING" }
    | { readonly status: "FAILED"; readonly failure: string }
    | { readonly status: "DONE"; readonly signals: DiscoverySignals }
  readonly brief: (SetupBrief & { readonly confirmedAt: string }) | null
  readonly channelsReviewedAt: string | null
  readonly inventory: ChannelInventory
  readonly assessment: SetupAssessment | null
  readonly opportunity: GrowthOpportunity | null
  /** The agent's draft of the brief: RUNNING while it reads the site. Absent once the brief is confirmed. */
  readonly draft?: { readonly status: "RUNNING" } | { readonly status: "FAILED" } | { readonly status: "READY"; readonly value: SetupDraft }
}
