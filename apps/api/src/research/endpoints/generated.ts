// Endpoints generated from providers' official API specifications (see
// scripts/generate-research-endpoints.ts): read-only GET operations, with an
// input schema built from each operation's documented path and query
// parameters. Their answers are kept as compact JSON: long lists are cut,
// long text is shortened and machine-only link fields are dropped.
import { Schema } from "effect"
import { clean } from "../html.js"
import type { AnyEndpoint, Parsed } from "./types.js"
import github from "./generated/github.json" with { type: "json" }
import stripe from "./generated/stripe.json" with { type: "json" }
import youtube from "./generated/youtube.json" with { type: "json" }
import kgsearch from "./generated/kgsearch.json" with { type: "json" }
import analyticsadmin from "./generated/analyticsadmin.json" with { type: "json" }
import analyticsdata from "./generated/analyticsdata.json" with { type: "json" }
import searchconsole from "./generated/searchconsole.json" with { type: "json" }
import mybusinessbusinessinformation from "./generated/mybusinessbusinessinformation.json" with { type: "json" }
import mybusinessaccountmanagement from "./generated/mybusinessaccountmanagement.json" with { type: "json" }
import businessprofileperformance from "./generated/businessprofileperformance.json" with { type: "json" }
import mybusinessverifications from "./generated/mybusinessverifications.json" with { type: "json" }

interface GenParam { readonly n: string; readonly in: string; readonly r?: number; readonly t: string; readonly e?: ReadonlyArray<string>; readonly x?: number }
interface GenOp { readonly id: string; readonly title: string; readonly path: string; readonly params: ReadonlyArray<GenParam>; readonly docs: string }
interface GenFile { readonly provider: string; readonly platform: string; readonly base: string; readonly ops: ReadonlyArray<GenOp> }

const PATH_VALUE = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200), Schema.pattern(/^[A-Za-z0-9._~@:+=,-]+$/))
/** A reserved path value such as properties/123/dataStreams/9: slash-separated segments, never "." or "..". */
const RESERVED_VALUE = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300), Schema.pattern(/^(?!.*(^|\/)\.{1,2}(\/|$))[A-Za-z0-9._~@:+=,-]+(\/[A-Za-z0-9._~@:+=,-]+)*$/))
const fieldOf = (p: GenParam) => {
  const base = p.e?.length ? Schema.Literal(...(p.e as [string, ...string[]])) : p.t === "i" ? Schema.Int.pipe(Schema.between(0, 1_000_000_000)) : p.t === "b" ? Schema.Boolean
    : p.in === "path" ? (p.x ? RESERVED_VALUE : PATH_VALUE) : Schema.String.pipe(Schema.maxLength(500))
  return p.r ? base : Schema.optional(base)
}

/** Compact JSON for the model: lists cut, text shortened, link-template fields dropped. */
export const compactJson = (v: unknown, depth = 0): unknown => {
  if (typeof v === "string") return clean(v, 300) ?? ""
  if (Array.isArray(v)) return v.slice(0, 25).map(x => compactJson(x, depth + 1))
  if (v && typeof v === "object") {
    if (depth > 4) return "..."
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([k, x]) => !(/_url$|^url_template$|^_links$|^node_id$|gravatar_id/.test(k) && k !== "html_url") && x !== null && x !== "")
      .slice(0, 40).map(([k, x]) => [k, compactJson(x, depth + 1)]))
  }
  return v
}
const parseGeneric = (json: unknown): Parsed => {
  const list = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data
    : Array.isArray((json as { items?: unknown })?.items) ? (json as { items: unknown[] }).items : null
  if (list && !list.length) return { status: "NO_DATA", findings: {}, coverage: { note: "The provider returned no items. Not listed is not zero." } }
  return { status: "OBSERVED", findings: { label: "SEEN", ...(list ? { items: compactJson(list), count: list.length } : { result: compactJson(json) }) },
    coverage: { note: "As the provider's official API returned it now, shortened: lists are cut at 25 and long text at 300 characters." } }
}

const toEndpoints = (file: GenFile): AnyEndpoint[] => file.ops.map(op => {
  const input = Schema.Struct(Object.fromEntries(op.params.map(p => [p.n, fieldOf(p)]))) as unknown as AnyEndpoint["input"]
  const pathParams = op.params.filter(p => p.in === "path")
  return {
    id: op.id, provider: file.provider, platform: file.platform, title: op.title, label: "SEEN", input, docs: op.docs,
    description: `${op.title}. Official ${file.provider.startsWith("google") ? "Google" : file.provider === "github" ? "GitHub" : "Stripe"} API, read-only (GET ${op.path}).`,
    subject: (i: Record<string, unknown>) => pathParams.map(p => String(i[p.n] ?? "")).filter(Boolean).join("/").slice(0, 300) || op.id,
    request: (i: Record<string, unknown>) => {
      let path = op.path
      for (const p of pathParams) {
        const v = String(i[p.n] ?? "")
        path = path.replace(`{${p.n}}`, encodeURIComponent(v)).replace(`{+${p.n}}`, v.split("/").map(encodeURIComponent).join("/"))
      }
      const query = Object.fromEntries(op.params.filter(p => p.in === "query" && i[p.n] !== undefined).map(p => [p.n, i[p.n] as string | number | boolean]))
      return { method: "GET" as const, url: `${file.base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, query,
        ...(file.provider === "github" ? { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } } : {}) }
    },
    parse: (json: unknown) => parseGeneric(json),
  } satisfies AnyEndpoint
})

export const GENERATED_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [github, stripe, youtube, kgsearch, analyticsadmin, analyticsdata, searchconsole,
  mybusinessbusinessinformation, mybusinessaccountmanagement, businessprofileperformance, mybusinessverifications].flatMap(f => toEndpoints(f as unknown as GenFile))
