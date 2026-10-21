import { afterEach, describe, expect, it, vi } from "vitest"
import {
  EXECUTION_HEAD_BRANCH, GitHubError, allowlistAllows, executionHeadBranch, executionPatchSha256, executionPullRequestText, fetchGitHubTransport, fixtureGitHub, gitBlobSha,
  parseRepositoryAllowlist, removeNoindexFromHtml, validGitHubEndpoint,
} from "../src/index.js"

const binding = { actionKind: "REMOVE_NOINDEX_META", owner: "acme", repository: "site", baseBranch: "main", baseCommitSha: "a".repeat(40), filePath: "p.html", liveUrl: "https://acme.test/p.html", beforeSha256: "b".repeat(64), afterSha256: "c".repeat(64) }
describe("connected execution transport", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("binds the patch identity to every part of the approved change", () => {
    const base = executionPatchSha256(binding)
    expect(base).toMatch(/^[a-f0-9]{64}$/)
    expect(executionPatchSha256({ ...binding })).toBe(base)
    expect(executionPatchSha256({ ...binding, owner: "ACME", repository: "SITE" })).toBe(base)      // repository identity is case-insensitive
    for (const [k, v] of Object.entries({ owner: "other", repository: "other", baseBranch: "release", baseCommitSha: "d".repeat(40), filePath: "q.html", liveUrl: "https://acme.test/q.html", beforeSha256: "e".repeat(64), afterSha256: "f".repeat(64), actionKind: "OTHER" })) {
      expect(executionPatchSha256({ ...binding, [k]: v }), k).not.toBe(base)
    }
  })

  it("uses one deterministic, constrained head branch per operation", () => {
    const id = "00000000-0000-4000-8000-000000000001"
    expect(executionHeadBranch(id)).toBe(`openrecord/exec-${id}`)
    expect(EXECUTION_HEAD_BRANCH.test(executionHeadBranch(id))).toBe(true)
    for (const bad of ["main", "openrecord/exec-x", `openrecord/exec-${id}/../main`, `../openrecord/exec-${id}`]) expect(EXECUTION_HEAD_BRANCH.test(bad), bad).toBe(false)
    const text = executionPullRequestText({ operationId: id, filePath: "p.html", patchSha256: "a".repeat(64), diff: "-x\n+y", rationale: "why", liveUrl: "https://acme.test/p.html" })
    expect(text.body).toContain("does not merge or deploy")
    expect(text.body).toContain("a".repeat(64))
  })

  it("parses the per-account repository allowlist strictly", () => {
    const acct = "11111111-1111-4111-8111-111111111111"
    const allow = allowlistAllows(parseRepositoryAllowlist(`Acme/Site=${acct}, bad entry, other/x=not-a-uuid, ../x/y=${acct}`))
    expect(allow("acme", "site", acct)).toBe(true)
    expect(allow("ACME", "SITE", acct.toUpperCase())).toBe(true)
    expect(allow("acme", "site", "22222222-2222-4222-8222-222222222222")).toBe(false)
    expect(allow("other", "x", acct)).toBe(false)
    expect(allow("..", "x", acct)).toBe(false)
    expect(allowlistAllows(parseRepositoryAllowlist(undefined))("acme", "site", acct)).toBe(false)
  })

  it("only ever sends the token to https or an exact loopback endpoint", () => {
    for (const ok of ["https://api.github.com", "https://github.example.com/api/v3", "http://127.0.0.1:4010", "http://localhost:4010"]) expect(validGitHubEndpoint(ok), ok).toBe(true)
    for (const bad of ["http://api.github.com", "http://10.0.0.5", "ftp://x", "https://user:pw@api.github.com", "https://api.github.com?x=1", "https://api.github.com#f", "not a url", "http://127.0.0.1.evil.test"]) expect(validGitHubEndpoint(bad), bad).toBe(false)
  })

  it("maps provider responses to stable errors and never repeats the credential", async () => {
    const respond = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers }))
    const run = async (status: number, headers: Record<string, string> = {}) => {
      vi.stubGlobal("fetch", respond(status, { message: "Bearer ghp_SECRET leaked? " }, headers))
      try { await fetchGitHubTransport("ghp_SECRET", "https://api.github.com").branchHead("a", "b", "main"); return null } catch (e) { return e as GitHubError }
    }
    expect((await run(401))!.kind).toBe("AUTH")
    expect((await run(403))!.kind).toBe("AUTH")
    const limited = (await run(403, { "x-ratelimit-remaining": "0" }))!
    expect(limited.kind).toBe("RATE_LIMITED")
    const retry = (await run(429, { "retry-after": "45" }))!
    expect(retry).toMatchObject({ kind: "RATE_LIMITED", retryAfterSeconds: 45 })
    expect((await run(503))!.kind).toBe("UNAVAILABLE")
    for (const e of [await run(401), limited, retry]) { expect(e!.message).not.toMatch(/ghp_|bearer|secret/i) }
    // 404 on a ref is "absent", not an error.
    vi.stubGlobal("fetch", respond(404))
    expect(await fetchGitHubTransport("t", "https://api.github.com").branchHead("a", "b", "main")).toBeNull()
    // The token travels only as a header, to the configured endpoint, without following redirects.
    const spy = respond(200, { object: { sha: "a".repeat(40) } }); vi.stubGlobal("fetch", spy)
    await fetchGitHubTransport("ghp_TOKEN", "https://api.github.com").branchHead("a", "b", "main")
    const [calledUrl, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe("https://api.github.com/repos/a/b/git/ref/heads/main")
    expect(init.redirect).toBe("error")
    expect(JSON.stringify(init.headers)).toContain("Bearer ghp_TOKEN")
    expect(calledUrl).not.toContain("ghp_TOKEN")
    // A network failure or timeout is its own, uncertain kind.
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("boom"), { name: "TimeoutError" }) }))
    await expect(fetchGitHubTransport("t", "https://api.github.com").repository("a", "b")).rejects.toMatchObject({ kind: "TIMEOUT" })
  })

  it("keeps symlinks, directories and oversized or binary files out of reach", async () => {
    const reply = (json: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })))
    const t = fetchGitHubTransport("t", "https://api.github.com")
    reply([{ type: "file" }]); expect(await t.file("a", "b", "p.html", "main")).toEqual({ kind: "not_file" })
    reply({ type: "symlink" }); expect(await t.file("a", "b", "p.html", "main")).toEqual({ kind: "not_file" })
    reply({ type: "submodule" }); expect(await t.file("a", "b", "p.html", "main")).toEqual({ kind: "not_file" })
    reply({ type: "file", size: 999_999, encoding: "base64", content: "", sha: "a".repeat(40) }); expect(await t.file("a", "b", "p.html", "main")).toEqual({ kind: "too_large" })
    reply({ type: "file", size: 3, encoding: "base64", content: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"), sha: "a".repeat(40) }); expect(await t.file("a", "b", "p.html", "main")).toEqual({ kind: "not_text" })
    reply({ type: "file", size: 2, encoding: "base64", content: Buffer.from("hi").toString("base64"), sha: "a".repeat(40) }); expect(await t.file("a", "b", "p.html", "main")).toMatchObject({ kind: "file", content: "hi" })
  })

  it("applies only the deterministic noindex transform", () => {
    expect(removeNoindexFromHtml('<head>\n<meta name="robots" content="noindex">\n</head>')).toBe("<head>\n\n</head>")
    expect(removeNoindexFromHtml('<meta name="robots" content="noindex, follow">')).toContain('content="follow"')
    expect(removeNoindexFromHtml('<meta name="robots" content="index, follow">')).toBeNull()
    expect(removeNoindexFromHtml("<html>no directive</html>")).toBeNull()
  })

  it("the fixture provider models merges, closures and failures without ever writing to the base branch itself", async () => {
    const fx = fixtureGitHub({ owner: "a", repo: "b", branch: "main", files: { "p.html": "old" } })
    const head = (await fx.transport.branchHead("a", "b", "main"))!
    expect(await fx.transport.createBranch("a", "b", "x", head)).toBe("created")
    expect(await fx.transport.createBranch("a", "b", "x", head)).toBe("exists")
    await fx.transport.putFile("a", "b", { path: "p.html", branch: "x", content: "new", expectedBlobSha: gitBlobSha("old"), message: "m" })
    await expect(fx.transport.putFile("a", "b", { path: "p.html", branch: "x", content: "newer", expectedBlobSha: gitBlobSha("old"), message: "m" })).rejects.toMatchObject({ kind: "CONFLICT" })
    expect((await fx.transport.file("a", "b", "p.html", "main")).kind === "file" && (await fx.transport.file("a", "b", "p.html", "main") as { content: string }).content).toBe("old")
    const pr = await fx.transport.createPullRequest("a", "b", { head: "x", base: "main", title: "t", body: "b" })
    expect(await fx.transport.pullRequestFiles("a", "b", pr.number)).toEqual([{ path: "p.html", status: "modified" }])
    fx.merge(pr.number)
    const merged = await fx.transport.pullRequest("a", "b", pr.number)
    expect(merged).toMatchObject({ merged: true, state: "closed" })
    expect(await fx.transport.file("a", "b", "p.html", merged.mergeCommitSha!)).toMatchObject({ kind: "file", content: "new" })
    expect(await fx.transport.repository("other", "b")).toBeNull()
  })
})
