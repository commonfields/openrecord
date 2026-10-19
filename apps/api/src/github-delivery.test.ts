import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { GitHubError, allowlistAllows, fetchGitHubTransport, fixtureGitHub, gitBlobSha, parseRepositoryAllowlist } from "./github-delivery.js"
import { serveFixtureGitHub } from "./github-delivery.fake-server.js"

// The REST transport against a local stand-in: request shapes, response
// mapping and error classification, with no request to GitHub.

const closers: Array<() => Promise<void>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

describe("GitHub delivery transport", () => {
  it("computes git blob ids like git hash-object", () => {
    expect(gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
    expect(gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
  })

  it("binds each allowlisted repository to exactly one account", () => {
    const account = "6b0b0f6a-1c1d-4c4e-8f2a-1b2c3d4e5f60"
    const allow = allowlistAllows(parseRepositoryAllowlist(`Acme/Site=${account}, other/repo=7c1c1f7b-2d2e-4d5f-9a3b-2c3d4e5f6a71, bad entry, ../x=${account}`))
    expect(allow("acme", "site", account)).toBe(true)
    expect(allow("ACME", "SITE", account.toUpperCase())).toBe(true)
    expect(allow("acme", "site", "7c1c1f7b-2d2e-4d5f-9a3b-2c3d4e5f6a71")).toBe(false)
    expect(allow("other", "repo", account)).toBe(false)
    expect(allow("..", "x", account)).toBe(false)
  })

  it("performs the full delivery through the REST transport against a stand-in", async () => {
    const fx = fixtureGitHub({ owner: "acme", repo: "site", branch: "main", files: { "content/home.md": "# Old\n" } })
    const server = await serveFixtureGitHub(fx, { token: "TEST-token" })
    closers.push(server.close)
    const gh = fetchGitHubTransport("TEST-token", server.url)
    expect(await gh.repository("acme", "site")).toEqual({ defaultBranch: "main" })
    expect(await gh.repository("acme", "missing")).toBeNull()
    const base = (await gh.branchHead("acme", "site", "main"))!
    expect(base).toMatch(/^[a-f0-9]{40}$/)
    const file = await gh.file("acme", "site", "content/home.md", base)
    expect(file).toEqual({ kind: "file", blobSha: gitBlobSha("# Old\n"), content: "# Old\n" })
    expect(await gh.file("acme", "site", "content/none.md", base)).toEqual({ kind: "missing" })
    expect(await gh.createBranch("acme", "site", "openrecord/growth-x", base)).toBe("created")
    expect(await gh.createBranch("acme", "site", "openrecord/growth-x", base)).toBe("exists")
    const { commitSha } = await gh.putFile("acme", "site", { path: "content/home.md", branch: "openrecord/growth-x", content: "# New\n", expectedBlobSha: gitBlobSha("# Old\n"), message: "TEST" })
    expect(commitSha).toMatch(/^[a-f0-9]{40}$/)
    await expect(gh.putFile("acme", "site", { path: "content/home.md", branch: "openrecord/growth-x", content: "# Again\n", expectedBlobSha: gitBlobSha("# Old\n"), message: "TEST" }))
      .rejects.toMatchObject({ kind: "CONFLICT" })
    expect(await gh.findPullRequest("acme", "site", "openrecord/growth-x", "main")).toBeNull()
    const pr = await gh.createPullRequest("acme", "site", { head: "openrecord/growth-x", base: "main", title: "TEST", body: "TEST" })
    expect(pr).toMatchObject({ number: 1, url: "https://github.com/acme/site/pull/1", state: "open", merged: false })
    await expect(gh.createPullRequest("acme", "site", { head: "openrecord/growth-x", base: "main", title: "TEST", body: "TEST" })).rejects.toMatchObject({ kind: "CONFLICT" })
    expect((await gh.findPullRequest("acme", "site", "openrecord/growth-x", "main"))?.number).toBe(1)
    fx.merge(1)
    expect(await gh.pullRequest("acme", "site", 1)).toMatchObject({ merged: true, state: "closed", mergeCommitSha: expect.stringMatching(/^[a-f0-9]{40}$/) })
    expect(fx.writes).toEqual(["branch:openrecord/growth-x", "commit:openrecord/growth-x:content/home.md", "pr:1"])
  })

  it("classifies refusals and outages without exposing GitHub's message", async () => {
    const fx = fixtureGitHub({ owner: "acme", repo: "site", branch: "main", files: {} })
    const server = await serveFixtureGitHub(fx, { token: "right" })
    closers.push(server.close)
    await expect(fetchGitHubTransport("wrong", server.url).repository("acme", "site")).rejects.toMatchObject({ kind: "AUTH" })

    let status = 403, headers: Record<string, string> = { "x-ratelimit-remaining": "0" }
    const raw = createServer((req, res) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end("{}") })
    await new Promise<void>(r => raw.listen(0, "127.0.0.1", r))
    closers.push(() => new Promise(r => raw.close(() => r())))
    const gh = fetchGitHubTransport("t", `http://127.0.0.1:${(raw.address() as AddressInfo).port}`)
    await expect(gh.repository("a", "b")).rejects.toMatchObject({ kind: "RATE_LIMITED" })
    status = 502; headers = {}
    await expect(gh.repository("a", "b")).rejects.toMatchObject({ kind: "UNAVAILABLE" })
    await expect(fetchGitHubTransport("t", "http://127.0.0.1:1").repository("a", "b")).rejects.toBeInstanceOf(GitHubError)
  })

  it("refuses symlinks, directories and oversized files instead of following them", async () => {
    const replies: Record<string, unknown> = {
      "/repos/a/b/contents/link.md": { type: "symlink", size: 10, encoding: "base64", sha: "x", content: "" },
      "/repos/a/b/contents/dir.md": [{ type: "file" }],
      "/repos/a/b/contents/big.md": { type: "file", size: 999_999, encoding: "base64", sha: "x", content: "" },
      "/repos/a/b/contents/bin.md": { type: "file", size: 2, encoding: "base64", sha: "x", content: Buffer.from([0xff, 0xfe]).toString("base64") },
    }
    const raw = createServer((req, res) => {
      const body = replies[new URL(req.url ?? "/", "http://x").pathname]
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(body ?? {}))
    })
    await new Promise<void>(r => raw.listen(0, "127.0.0.1", r))
    closers.push(() => new Promise(r => raw.close(() => r())))
    const gh = fetchGitHubTransport("t", `http://127.0.0.1:${(raw.address() as AddressInfo).port}`)
    expect(await gh.file("a", "b", "link.md", "main")).toEqual({ kind: "not_file" })
    expect(await gh.file("a", "b", "dir.md", "main")).toEqual({ kind: "not_file" })
    expect(await gh.file("a", "b", "big.md", "main")).toEqual({ kind: "too_large" })
    expect(await gh.file("a", "b", "bin.md", "main")).toEqual({ kind: "not_text" })
  })
})
