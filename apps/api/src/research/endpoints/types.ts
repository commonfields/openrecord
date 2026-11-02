// OpenRecord's research endpoint catalog: read-only calls to documented
// official and public APIs, described as data. A provider says where its API
// lives and how a business's own account authenticates; an endpoint says how
// one read is built from a typed input and how its answer becomes findings.
// The executor (http.ts, run.ts) does the rest the same way for every
// endpoint: pinned SSRF-safe connection to the provider's own hosts only,
// credential injected on the server, size-capped response, stable failure
// reasons, and a saved research observation.
import type { Schema } from "effect"
import type { Label } from "../types.js"

export type Auth =
  | { readonly kind: "none" }
  /** An API key the business adds; sent as a query parameter or header. */
  | { readonly kind: "api_key"; readonly in: "query" | "header"; readonly name: string; readonly optional?: boolean }
  /** A bearer token the business adds. */
  | { readonly kind: "bearer"; readonly optional?: boolean }
  /** login:password, sent as HTTP Basic. */
  | { readonly kind: "basic" }
  /** client_id:client_secret, exchanged for a short-lived token at tokenUrl (client credentials grant). */
  | { readonly kind: "client_credentials"; readonly tokenUrl: string }
  /** A Google connection the business already made on the Channels page (Analytics, Search Console or Business Profile). */
  | { readonly kind: "google_connection"; readonly connection: "analytics" | "search_console" | "business_profile" }
  /** The business's existing Meta connection (read-only ads scope). */
  | { readonly kind: "meta_connection" }

export interface Provider {
  readonly id: string
  readonly name: string
  /** Every host this provider's endpoints may call. Anything else is refused. */
  readonly hosts: ReadonlyArray<string>
  readonly auth: Auth
  /** What the business does to get a credential, in plain words, and where. */
  readonly connect?: { readonly how: string; readonly url: string; readonly format: RegExp; readonly example: string }
  /** Extra request headers the provider's terms require (for example a declared contact). */
  readonly headers?: (env: NodeJS.ProcessEnv) => Readonly<Record<string, string>> | null
  /** Shown with every result: terms, quotas, costs. */
  readonly note: string
  /** Paid by the business's own provider account. Off unless the business connects it. */
  readonly paid?: boolean
  /**
   * The server environment variable holding OpenRecord's own credential for
   * this provider. When set, priced endpoints work without the business
   * having its own account, paid from the account's research credit
   * (metering.ts). The business's own connection always wins.
   */
  readonly platformKeyEnv?: string
}

/** What OpenRecord charges for one call served on its own provider account, in micro-dollars (1,000,000 = $1). */
export interface Price { readonly microUsd: number }

export interface Request {
  readonly method: "GET" | "POST"
  readonly url: string
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}
export type Parsed = { readonly status: "OBSERVED" | "NO_DATA"; readonly findings: Record<string, unknown>; readonly coverage?: Record<string, unknown> } | { readonly failed: string }

export interface Endpoint<I = unknown> {
  readonly id: string
  readonly provider: string
  readonly platform: string
  readonly title: string
  readonly description: string
  readonly label: Label
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly input: Schema.Schema<I, any, never>
  readonly subject: (input: I) => string
  readonly request: (input: I, now: Date) => Request
  /** Turns the provider's JSON into findings; the raw answer is never stored whole. */
  readonly parse: (json: unknown, input: I) => Parsed
  readonly cache?: "day" | "none"
  readonly docs: string
  /** Price when served on OpenRecord's own account. Unpriced endpoints are never served on it. */
  readonly price?: Price
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyEndpoint = Endpoint<any>
