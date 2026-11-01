// Generates read-only research endpoint definitions from providers' official
// API specifications, the way a gateway curates its catalog:
//
//   GitHub REST (OpenAPI, MIT), Stripe (OpenAPI, MIT), and Google API
//   discovery documents (YouTube Data, Knowledge Graph Search).
//
// Only GET operations are kept, and paths for administration, secrets, keys,
// billing or the caller's own account are dropped. Output is compact JSON in
// src/research/endpoints/generated/, loaded at runtime by generated.ts.
//
//   pnpm --filter @openrecord/api exec tsx scripts/generate-research-endpoints.ts [specDir]
//
// specDir holds github.json, stripe.json, youtube.json and kgsearch.json;
// without it the specs are downloaded.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SOURCES = {
  github: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
  stripe: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  youtube: "https://youtube.googleapis.com/$discovery/rest?version=v3",
  kgsearch: "https://kgsearch.googleapis.com/$discovery/rest?version=v1",
  analyticsadmin: "https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta",
  analyticsdata: "https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta",
  searchconsole: "https://searchconsole.googleapis.com/$discovery/rest?version=v1",
  mybusinessbusinessinformation: "https://mybusinessbusinessinformation.googleapis.com/$discovery/rest?version=v1",
  mybusinessaccountmanagement: "https://mybusinessaccountmanagement.googleapis.com/$discovery/rest?version=v1",
  businessprofileperformance: "https://businessprofileperformance.googleapis.com/$discovery/rest?version=v1",
  mybusinessverifications: "https://mybusinessverifications.googleapis.com/$discovery/rest?version=v1",
} as const
/** Google APIs read through a connection the business already made, by output file. */
const GOOGLE_CONNECTED: ReadonlyArray<{ readonly file: keyof typeof SOURCES; readonly provider: string; readonly platform: string; readonly prefix: string }> = [
  { file: "analyticsadmin", provider: "google_analytics", platform: "analytics", prefix: "analytics.admin" },
  { file: "analyticsdata", provider: "google_analytics", platform: "analytics", prefix: "analytics.data" },
  { file: "searchconsole", provider: "google_search_console", platform: "search", prefix: "search.console" },
  { file: "mybusinessbusinessinformation", provider: "google_business_profile", platform: "local", prefix: "local.profile" },
  { file: "mybusinessaccountmanagement", provider: "google_business_profile", platform: "local", prefix: "local.accounts" },
  { file: "businessprofileperformance", provider: "google_business_profile", platform: "local", prefix: "local.performance" },
  { file: "mybusinessverifications", provider: "google_business_profile", platform: "local", prefix: "local.verifications" },
]

/** x: a reserved path parameter ({+name}) whose value keeps its slashes, such as properties/123. */
export interface GenParam { readonly n: string; readonly in: "path" | "query"; readonly r?: 1; readonly t: "s" | "i" | "b"; readonly e?: ReadonlyArray<string>; readonly x?: 1 }
export interface GenOp { readonly id: string; readonly title: string; readonly path: string; readonly params: ReadonlyArray<GenParam>; readonly docs: string }
export interface GenFile { readonly provider: string; readonly platform: string; readonly base: string; readonly source: string; readonly ops: ReadonlyArray<GenOp> }

const short = (s: unknown, max = 140) => String(s ?? "").replace(/\s+/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim().slice(0, max)
const idPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
const fit = (id: string) => id.length <= 60 ? id : `${id.slice(0, 51)}_${Buffer.from(id).toString("base64url").slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x")}`
const typeOf = (schema: Record<string, unknown> | undefined): GenParam["t"] => {
  const t = schema?.["type"]
  return t === "integer" || t === "number" ? "i" : t === "boolean" ? "b" : "s"
}
const enumOf = (schema: Record<string, unknown> | undefined) => Array.isArray(schema?.["enum"]) && (schema!["enum"] as unknown[]).every(x => typeof x === "string") && (schema!["enum"] as string[]).length <= 30 ? schema!["enum"] as string[] : undefined

// ---------------------------------------------------------------- OpenAPI

const GITHUB_SKIP = /^\/(user|users\/\{username\}\/(settings|ssh_signing_keys|gpg_keys|keys)|notifications|app|apps\/\{app_slug\}\/installations|installation|admin|enterprises|scim|marketplace_listing|applications|authorizations|networks|feeds|setup|manage)(\/|$)|secrets|\/keys(\/|$)|hooks|invitations|credential|codespaces|copilot|billing|audit-log|settings|actions\/(runners|oidc|permissions|cache)|dependabot|private-registries|attestations|interaction-limits|rulesets\/rule-suites|security-managers|outside_collaborators|failed_invitations|personal-access-token|migrations|blocks/
const STRIPE_SKIP = /\/test_helpers\/|\/files\/\{file\}\/contents|\/ephemeral_keys|\/account_links|\/login_links|\/v1\/apps\/secrets|\/sigma\//

const fromOpenApi = (spec: Record<string, unknown>, provider: string, platform: string, base: string, skip: RegExp, docs: (op: Record<string, unknown>, path: string) => string, name: (op: Record<string, unknown>, path: string) => string): GenOp[] => {
  const ops: GenOp[] = []
  const comp = ((spec["components"] as Record<string, unknown> | undefined)?.["parameters"] ?? {}) as Record<string, Record<string, unknown>>
  for (const [path, item] of Object.entries(spec["paths"] as Record<string, Record<string, unknown>>)) {
    const op = item["get"] as Record<string, unknown> | undefined
    if (!op || skip.test(path) || op["deprecated"]) continue
    const params = ([...(item["parameters"] as unknown[] ?? []), ...(op["parameters"] as unknown[] ?? [])] as Array<Record<string, unknown>>)
      .map(p => p["$ref"] ? comp[String(p["$ref"]).split("/").pop()!] : p).filter((p): p is Record<string, unknown> => !!p && (p["in"] === "path" || p["in"] === "query"))
      .filter(p => typeof p["name"] === "string" && /^[A-Za-z0-9_.[\]-]{1,60}$/.test(p["name"] as string) && !/\[/.test(p["name"] as string))
    const unique = [...new Map(params.map(p => [String(p["name"]), p])).values()].slice(0, 20)
    ops.push({ id: fit(`${provider === "github" ? "dev.github" : "revenue.stripe"}.${name(op, path)}`), title: short(op["summary"] ?? op["description"] ?? path, 120), path, docs: docs(op, path),
      params: unique.map(p => ({ n: String(p["name"]), in: p["in"] as "path" | "query", ...(p["required"] || p["in"] === "path" ? { r: 1 as const } : {}), t: typeOf(p["schema"] as Record<string, unknown>), ...(enumOf(p["schema"] as Record<string, unknown>) ? { e: enumOf(p["schema"] as Record<string, unknown>)! } : {}) })) })
  }
  return ops
}

// ---------------------------------------------------------------- Google discovery

const fromDiscovery = (doc: Record<string, unknown>, prefix: string): GenOp[] => {
  const ops: GenOp[] = []
  const base = `${doc["rootUrl"]}${doc["servicePath"] ?? ""}`
  const walk = (resources: Record<string, Record<string, unknown>> | undefined, trail: string[]) => {
    for (const [rname, res] of Object.entries(resources ?? {})) {
      for (const [mname, m] of Object.entries((res["methods"] ?? {}) as Record<string, Record<string, unknown>>)) {
        if (m["httpMethod"] !== "GET") continue
        const params = Object.entries((m["parameters"] ?? {}) as Record<string, Record<string, unknown>>).filter(([n, p]) => (p["location"] === "query" || p["location"] === "path") && n !== "key" && n !== "onBehalfOfContentOwner" && n !== "onBehalfOfContentOwnerChannel")
        ops.push({ id: fit(`${prefix}.${[...trail, rname, mname].map(idPart).join(".")}`), title: short(m["description"] ?? `${rname} ${mname}`, 120), path: `${base}${m["path"]}`.replace(base, ""),
          docs: String(doc["documentationLink"] ?? base).replace(/^http:/, "https:"),
          params: params.slice(0, 20).map(([n, p]) => ({ n, in: p["location"] as "path" | "query", ...(p["required"] ? { r: 1 as const } : {}), ...(String(m["path"]).includes(`{+${n}}`) ? { x: 1 as const } : {}), t: p["type"] === "integer" || p["type"] === "number" ? "i" as const : p["type"] === "boolean" ? "b" as const : "s" as const,
            ...(Array.isArray(p["enum"]) && (p["enum"] as unknown[]).length <= 30 ? { e: p["enum"] as string[] } : {}) })) })
      }
      walk(res["resources"] as Record<string, Record<string, unknown>> | undefined, [...trail, rname])
    }
  }
  walk(doc["resources"] as Record<string, Record<string, unknown>>, [])
  return ops
}

const load = async (dir: string | undefined, name: keyof typeof SOURCES) => dir ? JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Record<string, unknown>
  : await (await fetch(SOURCES[name])).json() as Record<string, unknown>

const main = async () => {
  const dir = process.argv[2]
  const out = join(import.meta.dirname, "../src/research/endpoints/generated")
  mkdirSync(out, { recursive: true })
  const github = await load(dir, "github"), stripe = await load(dir, "stripe"), youtube = await load(dir, "youtube"), kg = await load(dir, "kgsearch")
  const files: GenFile[] = [
    { provider: "github", platform: "developers", base: "https://api.github.com", source: SOURCES.github,
      ops: fromOpenApi(github, "github", "developers", "https://api.github.com", GITHUB_SKIP,
        op => String(((op["externalDocs"] as Record<string, unknown> | undefined)?.["url"]) ?? "https://docs.github.com/rest"),
        op => String(op["operationId"] ?? "").split(/[/]/).map(idPart).join(".")) },
    { provider: "stripe", platform: "revenue", base: "https://api.stripe.com", source: SOURCES.stripe,
      ops: fromOpenApi(stripe, "stripe", "revenue", "https://api.stripe.com", STRIPE_SKIP, () => "https://docs.stripe.com/api",
        (_op, path) => path.replace(/^\/v1\//, "").replace(/\{[^}]+\}/g, "one").split("/").map(idPart).join(".")) },
    { provider: "google_api", platform: "social", base: `${youtube["rootUrl"]}${youtube["servicePath"] ?? ""}`, source: SOURCES.youtube, ops: fromDiscovery(youtube, "social.youtube_api") },
    { provider: "google_api", platform: "reference", base: `${kg["rootUrl"]}${kg["servicePath"] ?? ""}`, source: SOURCES.kgsearch, ops: fromDiscovery(kg, "reference.knowledge_graph") },
  ]
  for (const g of GOOGLE_CONNECTED) {
    const doc = await load(dir, g.file)
    files.push({ provider: g.provider, platform: g.platform, base: `${doc["rootUrl"]}${doc["servicePath"] ?? ""}`, source: SOURCES[g.file], ops: fromDiscovery(doc, g.prefix) })
  }
  for (const f of files) {
    const ids = new Set<string>()
    const ops = f.ops.filter(o => !ids.has(o.id) && ids.add(o.id))
    const name = Object.entries(SOURCES).find(([, url]) => url === f.source)![0]
    writeFileSync(join(out, `${name}.json`), JSON.stringify({ ...f, ops }))
    console.log(`${f.provider} ${f.platform}: ${ops.length} read operations`)
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
