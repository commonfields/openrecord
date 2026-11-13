import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, AcquisitionRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import pg from "pg"
import { dispatchToolSpec } from "./agent-registry.js"
import { artifactDocument, markdownToHtml, mergeArtifacts } from "./artifacts.js"
import { memoryJournal } from "./agent-run.js"
import { runConversation } from "./agent.js"
import { classifyToolFailure } from "./agent-registry.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { makeRouter, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("artifacts (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    RepoLayers.SetupRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive,
    EvidenceLineageRepositoryLive, DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
    RepoLayers.AssayRepositoryLive,
    RepoLayers.AssayReviewRepositoryLive,
    RepoLayers.BusinessRepositoryLive,
    RepoLayers.FactRepositoryLive,
    RepoLayers.QuestionRepositoryLive,
    RepoLayers.CheckRunRepositoryLive,
    RepoLayers.ObservationRepositoryLive,
    RepoLayers.ClaimRepositoryLive,
    RepoLayers.JudgmentRepositoryLive,
    RepoLayers.ReobservationIntentRepositoryLive,
    RepoLayers.ReobservationRepositoryLive,
    RepoLayers.ProductReadRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive,
    RepoLayers.DiscoveryRunRepositoryLive,
    RepoLayers.DiscoveryFrontierRepositoryLive,
    RepoLayers.SiteTargetRepositoryLive,
    RepoLayers.SiteRunRepositoryLive,
    RepoLayers.SitePageObservationRepositoryLive,
    RepoLayers.SiteFindingRepositoryLive,
    RepoLayers.SiteFindingEventRepositoryLive,
    RepoLayers.SiteFixProposalRepositoryLive,
    RepoLayers.SiteMutationRepositoryLive,
    RepoLayers.SiteVerificationRepositoryLive,
    RepoLayers.SiteOperatorEventRepositoryLive,
    RepoLayers.SiteGscRepositoryLive,
    RepoLayers.GrowthMeasurementRepositoryLive,
  ).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )
  const web = HttpApp.toWebHandlerLayer(makeRouter(), repos)
  const run = <A, E>(effect: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.either(effect.pipe(Effect.provide(repos))))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const call = (method: string, path: string, session: string | null, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { ...(session ? { cookie: `or_session=${session}` } : {}), ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST artifacts') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`artifact-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Bakery') RETURNING id", [accountId])).rows[0].id)
    const session = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, businessId, session }
  }

  const PAGE = "<!doctype html><html><head><title>Wedding cakes</title><style>h1{color:#020c44}</style></head><body><h1>Wedding cakes in Bandung</h1><p>Order two weeks ahead.</p><script>alert(1)</script></body></html>"

  it("saves a piece once, edits it as new versions and refuses edits that do not match one place", async () => {
    const f = await fixture(), ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const created = await run(dispatchToolSpec(ctx, "create_artifact", { kind: "LANDING_PAGE", format: "HTML", title: "  Wedding cakes   page ", content: PAGE }))
    expect(created._tag).toBe("Right")
    const artifactId = created._tag === "Right" ? (created.right.data as { artifactId: string }).artifactId : ""
    expect(created._tag === "Right" && created.right).toMatchObject({ artifacts: [{ id: artifactId, title: "Wedding cakes page", kind: "LANDING_PAGE", format: "HTML", version: 1 }], data: { saved: true, published: false } })
    // A landing page is a designed page, never an outline.
    const outline = await run(dispatchToolSpec(ctx, "create_artifact", { kind: "LANDING_PAGE", format: "MARKDOWN", title: "Outline", content: "# Hero\n\nBuy cakes" }))
    expect(outline._tag === "Left" && classifyToolFailure(outline.left)).toMatchObject({ code: "REFUSED", retryable: true, guidance: expect.stringContaining("format HTML") })
    // A repeated call with the same content reuses the artifact instead of saving a copy.
    const again = await run(dispatchToolSpec(ctx, "create_artifact", { kind: "LANDING_PAGE", format: "HTML", title: "Another name", content: PAGE }))
    expect(again._tag === "Right" && again.right.data).toMatchObject({ artifactId, saved: false })
    const edited = await run(dispatchToolSpec(ctx, "edit_artifact", { artifactId, edits: [{ find: "two weeks", replace: "three weeks" }], note: "Longer lead time" }))
    expect(edited._tag === "Right" && edited.right).toMatchObject({ artifacts: [{ id: artifactId, version: 2 }] })
    for (const [find, reason] of [["four weeks", "EditNotFound"], ["e", "EditAmbiguous"]] as const) {
      const refused = await run(dispatchToolSpec(ctx, "edit_artifact", { artifactId, edits: [{ find, replace: "x" }] }))
      expect(refused._tag === "Left" && refused.left).toMatchObject({ _tag: "ArtifactRefused", reason, edit: 1 })
      expect(refused._tag === "Left" && classifyToolFailure(refused.left)).toMatchObject({ code: "REFUSED", retryable: true })
    }
    expect((await run(dispatchToolSpec(ctx, "edit_artifact", { artifactId, edits: [{ find: "three weeks", replace: "three weeks" }] })))).toMatchObject({ _tag: "Left", left: { reason: "NothingToChange" } })
    const read = await run(dispatchToolSpec(ctx, "read_artifact", { artifactId }))
    expect(read._tag === "Right" && read.right.data).toMatchObject({ version: 2, currentVersion: 2, content: expect.stringContaining("three weeks") })
    const first = await run(dispatchToolSpec(ctx, "read_artifact", { artifactId, version: 1 }))
    expect(first._tag === "Right" && first.right.data).toMatchObject({ version: 1, content: expect.stringContaining("two weeks") })
    const listed = await run(dispatchToolSpec(ctx, "list_artifacts", {}))
    expect(listed._tag === "Right" && listed.right.data).toMatchObject({ artifacts: [{ artifactId, version: 2, title: "Wedding cakes page" }] })
    // Another business can neither read nor edit it.
    const other = await fixture(), foreign = { accountId: other.accountId, userId: other.userId, businessId: other.businessId }
    expect((await run(dispatchToolSpec(foreign, "read_artifact", { artifactId })))._tag).toBe("Left")
    expect((await run(dispatchToolSpec(foreign, "edit_artifact", { artifactId, content: "stolen" })))._tag).toBe("Left")
    expect((await run(dispatchToolSpec(foreign, "list_artifacts", {})))).toMatchObject({ _tag: "Right", right: { data: { artifacts: [] } } })
  })

  it("serves the team's reads, edits, sandboxed previews and expiring public links over HTTP", async () => {
    const f = await fixture(), other = await fixture(), ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const created = await run(dispatchToolSpec(ctx, "create_artifact", { kind: "LANDING_PAGE", format: "HTML", title: "Wedding cakes page", content: PAGE }))
    const artifactId = created._tag === "Right" ? (created.right.data as { artifactId: string }).artifactId : ""
    const base = `/api/businesses/${f.businessId}/artifacts`
    expect((await call("GET", base, null)).status).toBe(401)
    expect((await call("GET", base, other.session)).status).toBe(404)
    expect((await call("GET", `/api/businesses/${other.businessId}/artifacts/${artifactId}`, other.session)).status).toBe(404)
    expect(await (await call("GET", base, f.session)).json()).toMatchObject({ artifacts: [{ id: artifactId, version: 1 }] })
    // A person's edit is a new version, refused from another site and when their copy is out of date.
    expect((await call("POST", `${base}/${artifactId}`, f.session, { baseVersion: 1, title: "Cakes" }, "https://hostile.example.test")).status).toBe(403)
    const saved = await call("POST", `${base}/${artifactId}`, f.session, { baseVersion: 1, content: PAGE.replace("Bandung", "Jakarta") })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ artifact: { version: 2, versions: [{ version: 2, source: "OPERATOR" }, { version: 1, source: "ASSISTANT" }] } })
    expect((await call("POST", `${base}/${artifactId}`, f.session, { baseVersion: 1, title: "Late" })).status).toBe(409)
    expect((await call("POST", `${base}/${artifactId}`, f.session, { baseVersion: 2 })).status).toBe(422)
    // The preview never runs the page's scripts: the policy sandboxes it and allows no script source.
    const preview = await call("GET", `${base}/${artifactId}/preview?version=1`, f.session)
    expect(preview.status).toBe(200)
    expect(preview.headers.get("content-security-policy")).toMatch(/^sandbox; default-src 'none'/)
    expect(preview.headers.get("content-security-policy")).not.toMatch(/script-src|allow-scripts/)
    expect(await preview.text()).toContain("Wedding cakes in Bandung")
    const download = await call("GET", `${base}/${artifactId}/preview?download=1`, f.session)
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="wedding-cakes-page.html"')
    expect((await call("GET", `/api/businesses/${other.businessId}/artifacts/${artifactId}/preview`, other.session)).status).toBe(404)
    // A link works without a session, shows the current version, and stops when the artifact is put away.
    expect((await call("POST", `/api/businesses/${other.businessId}/artifacts/${artifactId}/links`, other.session, {})).status).toBe(404)
    const link = await call("POST", `${base}/${artifactId}/links`, f.session, {})
    expect(link.status).toBe(201)
    const { path } = await link.json() as { path: string }
    expect(path).toMatch(/^\/api\/artifact-previews\/ora_/)
    const shared = await call("GET", path, null)
    expect(shared.status).toBe(200)
    expect(shared.headers.get("content-security-policy")).toMatch(/^sandbox;/)
    expect(await shared.text()).toContain("Wedding cakes in Jakarta")
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_artifact_links WHERE token_sha256 = $1", [path.split("/").pop()])).rows[0].n).toBe(0)
    expect((await call("GET", "/api/artifact-previews/ora_" + "x".repeat(43), null)).status).toBe(404)
    expect((await call("POST", `${base}/${artifactId}/archive`, f.session, {})).status).toBe(200)
    expect((await call("GET", path, null)).status).toBe(404)
    expect(await (await call("GET", base, f.session)).json()).toMatchObject({ artifacts: [] })
  })

  it("carries what a run wrote onto its reply and into the run journal", async () => {
    const f = await fixture(), ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const { events, journal } = memoryJournal()
    let step = 0
    const reply = await Effect.runPromise(runConversation({
      message: "Write a landing page for wedding cakes", history: [], journal,
      model: () => Effect.succeed({ candidates: [{ finishReason: "STOP", content: { role: "model" as const, parts: step++ === 0
        ? [{ functionCall: { name: "create_artifact", args: { kind: "LANDING_PAGE", format: "HTML", title: "Wedding cakes page", content: PAGE } } }]
        : [{ text: "I wrote the wedding cakes page. Check the lead time before it goes live." }] } }] }),
      dispatch: (name, args) => dispatchToolSpec(ctx, name, args).pipe(Effect.provide(repos)),
    }))
    expect(reply.artifacts).toMatchObject([{ title: "Wedding cakes page", kind: "LANDING_PAGE", version: 1 }])
    expect(reply.citations).toMatchObject([{ kind: "artifact", id: reply.artifacts[0]!.id }])
    // The reply never carries the artifact's identifier as text.
    expect(reply.reply).not.toContain(reply.artifacts[0]!.id)
    expect(events.find(e => e.type === "TOOL_COMPLETED")?.payload).toMatchObject({ tool: "create_artifact", effect: "record", artifacts: [{ id: reply.artifacts[0]!.id }] })
  })
})

describe("artifact pages", () => {
  it("renders Markdown as text, never as markup it was given", () => {
    const html = markdownToHtml("# Offer\n\nBuy **now** at [our shop](https://example.test/a) <script>alert(1)</script>\n\n- one\n- two\n\n1. first\n\n[bad](javascript:alert(1))")
    expect(html).toContain("<h1>Offer</h1>")
    expect(html).toContain("<strong>now</strong>")
    expect(html).toContain('<a href="https://example.test/a" rel="noreferrer noopener">our shop</a>')
    expect(html).toContain("<ul>\n<li>one</li>\n<li>two</li>\n</ul>")
    expect(html).toContain("<ol>\n<li>first</li>\n</ol>")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain('href="javascript')
  })
  it("wraps a fragment in a document and leaves a whole document as written", () => {
    expect(artifactDocument({ format: "HTML", title: "A <b>", content: "<h1>Hi</h1>" })).toMatch(/^<!doctype html>.*<title>A &lt;b&gt;<\/title>.*<h1>Hi<\/h1>/s)
    expect(artifactDocument({ format: "HTML", title: "A", content: "<html><body>x</body></html>" })).toBe("<html><body>x</body></html>")
    expect(artifactDocument({ format: "MARKDOWN", title: "A", content: "# Hi" })).toContain("<main><h1>Hi</h1></main>")
  })
  it("keeps the newest version of each artifact on a reply", () => {
    const ref = (id: string, version: number) => ({ id, title: "t", kind: "ARTICLE" as const, format: "MARKDOWN" as const, version })
    expect(mergeArtifacts([ref("a", 1), ref("b", 1), ref("a", 2)])).toEqual([ref("a", 2), ref("b", 1)])
  })
})
