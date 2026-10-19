// GitHub transport for marketing delivery (P2). The only GitHub operations
// OpenRecord performs: read a branch head and one file, create one branch,
// commit one file, open and read one pull request. No merge, no workflow
// dispatch, no other path. Credentials come from server configuration only:
//
//   GITHUB_DELIVERY_TOKEN         a fine-grained token limited to the
//                                 selected repositories (Contents and Pull
//                                 requests: read and write).
//   GITHUB_DELIVERY_REPOSITORIES  comma-separated owner/repo=<account id>.
//                                 A repository is usable only by the account
//                                 it is listed for, whatever the database says.
//   GITHUB_DELIVERY_API_URL       optional; defaults to https://api.github.com.
//                                 HTTPS or an exact loopback address only (a
//                                 local GitHub stand-in for development).
import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"
import { validProviderEndpoint } from "@openrecord/config"

export type GitHubErrorKind = "NOT_FOUND" | "CONFLICT" | "AUTH" | "RATE_LIMITED" | "INVALID" | "UNAVAILABLE" | "TIMEOUT"
export class GitHubError extends Error {
  constructor(readonly kind: GitHubErrorKind, message: string) { super(message) }
}

export type GitHubFile =
  | { readonly kind: "file"; readonly blobSha: string; readonly content: string }
  | { readonly kind: "missing" }
  | { readonly kind: "not_file" }
  | { readonly kind: "too_large" }
  | { readonly kind: "not_text" }

export interface GitHubPullRequest {
  readonly number: number; readonly url: string; readonly headSha: string
  readonly state: "open" | "closed"; readonly merged: boolean; readonly mergeCommitSha: string | null
  readonly mergedAt: string | null; readonly closedAt: string | null
}

export interface GitHubTransport {
  repository(owner: string, repo: string): Promise<{ readonly defaultBranch: string } | null>
  branchHead(owner: string, repo: string, branch: string): Promise<string | null>
  file(owner: string, repo: string, path: string, ref: string): Promise<GitHubFile>
  createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<"created" | "exists">
  putFile(owner: string, repo: string, change: { path: string; branch: string; content: string; expectedBlobSha: string; message: string }): Promise<{ readonly commitSha: string }>
  findPullRequest(owner: string, repo: string, head: string, base: string): Promise<GitHubPullRequest | null>
  createPullRequest(owner: string, repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<GitHubPullRequest>
  pullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest>
}

export const MAX_DELIVERY_FILE_BYTES = 256_000

/** Git's blob id: sha1("blob <bytes>\0<content>"). Lets the server compare content GitHub reports with the approved bytes. */
export const gitBlobSha = (content: string): string => {
  const bytes = Buffer.from(content, "utf8")
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}

export interface GitHubDeliveryConfig {
  /** Null when no token is configured: delivery is refused, never simulated. */
  readonly transport: GitHubTransport | null
  readonly allowed: (owner: string, repo: string, accountId: string) => boolean
}
export class GitHubDelivery extends Context.Tag("GitHubDelivery")<GitHubDelivery, GitHubDeliveryConfig>() {}

export const parseRepositoryAllowlist = (raw: string | undefined): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()
  for (const entry of (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)) {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})=([0-9a-f-]{36})$/i.exec(entry)
    if (match) map.set(`${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`, match[3]!.toLowerCase())
  }
  return map
}
export const allowlistAllows = (allowlist: ReadonlyMap<string, string>) => (owner: string, repo: string, accountId: string) =>
  allowlist.get(`${owner.toLowerCase()}/${repo.toLowerCase()}`) === accountId.toLowerCase()

const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/")

/** REST transport over fetch: bounded time and size, no redirects. */
export const fetchGitHubTransport = (token: string, baseUrl = "https://api.github.com"): GitHubTransport => {
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    let response: Response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
          "user-agent": "openrecord-growth-delivery", ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (e) {
      throw new GitHubError(e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : "UNAVAILABLE", "GitHub did not respond")
    }
    const text = await response.text()
    if (text.length > 2_000_000) throw new GitHubError("INVALID", "GitHub response too large")
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { throw new GitHubError("INVALID", "GitHub response was not JSON") }
    if (response.status === 401 || response.status === 403) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0"
      throw new GitHubError(limited ? "RATE_LIMITED" : "AUTH", limited ? "GitHub rate limit reached" : "GitHub refused the delivery credentials")
    }
    if (response.status === 429) throw new GitHubError("RATE_LIMITED", "GitHub rate limit reached")
    if (response.status >= 500) throw new GitHubError("UNAVAILABLE", `GitHub returned ${response.status}`)
    return { status: response.status, json }
  }
  const obj = (v: unknown) => (v !== null && typeof v === "object" ? v as Record<string, unknown> : {})
  const toPr = (raw: unknown): GitHubPullRequest => {
    const pr = obj(raw)
    const number = Number(pr["number"]), url = String(pr["html_url"] ?? "")
    if (!Number.isInteger(number) || !/^https:\/\/github\.com\//.test(url)) throw new GitHubError("INVALID", "unexpected pull request shape")
    return {
      number, url, headSha: String(obj(pr["head"])["sha"] ?? ""), state: pr["state"] === "closed" ? "closed" : "open", merged: pr["merged"] === true,
      mergeCommitSha: typeof pr["merge_commit_sha"] === "string" ? pr["merge_commit_sha"] : null,
      mergedAt: typeof pr["merged_at"] === "string" ? pr["merged_at"] : null, closedAt: typeof pr["closed_at"] === "string" ? pr["closed_at"] : null,
    }
  }
  const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  return {
    repository: async (owner, repo) => {
      const r = await call("GET", repoPath(owner, repo))
      if (r.status === 404) return null
      return { defaultBranch: String(obj(r.json)["default_branch"] ?? "") }
    },
    branchHead: async (owner, repo, branch) => {
      const r = await call("GET", `${repoPath(owner, repo)}/git/ref/heads/${segments(branch)}`)
      if (r.status === 404) return null
      const sha = obj(obj(r.json)["object"])["sha"]
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new GitHubError("INVALID", "unexpected ref shape")
      return sha
    },
    file: async (owner, repo, path, ref) => {
      const r = await call("GET", `${repoPath(owner, repo)}/contents/${segments(path)}?ref=${encodeURIComponent(ref)}`)
      if (r.status === 404) return { kind: "missing" }
      if (Array.isArray(r.json)) return { kind: "not_file" }
      const f = obj(r.json)
      // Symlinks and submodules report another type: refused, never followed.
      if (f["type"] !== "file") return { kind: "not_file" }
      if (Number(f["size"]) > MAX_DELIVERY_FILE_BYTES || f["encoding"] !== "base64") return { kind: "too_large" }
      let content: string
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(String(f["content"] ?? ""), "base64")) } catch { return { kind: "not_text" } }
      return { kind: "file", blobSha: String(f["sha"]), content }
    },
    createBranch: async (owner, repo, branch, fromSha) => {
      const r = await call("POST", `${repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha })
      if (r.status === 201) return "created"
      if (r.status === 422) return "exists"
      throw new GitHubError(r.status === 404 ? "NOT_FOUND" : "INVALID", `branch creation returned ${r.status}`)
    },
    putFile: async (owner, repo, change) => {
      const r = await call("PUT", `${repoPath(owner, repo)}/contents/${segments(change.path)}`, {
        message: change.message, branch: change.branch, sha: change.expectedBlobSha, content: Buffer.from(change.content, "utf8").toString("base64"),
      })
      if (r.status === 409 || r.status === 422) throw new GitHubError("CONFLICT", "the file changed on the branch")
      if (r.status !== 200 && r.status !== 201) throw new GitHubError(r.status === 404 ? "NOT_FOUND" : "INVALID", `commit returned ${r.status}`)
      const sha = obj(obj(r.json)["commit"])["sha"]
      if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new GitHubError("INVALID", "unexpected commit shape")
      return { commitSha: sha }
    },
    findPullRequest: async (owner, repo, head, base) => {
      const r = await call("GET", `${repoPath(owner, repo)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&per_page=5`)
      if (r.status !== 200 || !Array.isArray(r.json)) return null
      return r.json.length ? toPr(r.json[0]) : null
    },
    createPullRequest: async (owner, repo, pr) => {
      const r = await call("POST", `${repoPath(owner, repo)}/pulls`, { ...pr, draft: false, maintainer_can_modify: false })
      if (r.status === 422) throw new GitHubError("CONFLICT", "a pull request may already exist for this branch")
      if (r.status !== 201) throw new GitHubError(r.status === 404 ? "NOT_FOUND" : "INVALID", `pull request creation returned ${r.status}`)
      return toPr(r.json)
    },
    pullRequest: async (owner, repo, number) => {
      const r = await call("GET", `${repoPath(owner, repo)}/pulls/${number}`)
      if (r.status === 404) throw new GitHubError("NOT_FOUND", "pull request not found")
      return toPr(r.json)
    },
  }
}

export const GitHubDeliveryLive = Layer.sync(GitHubDelivery, () => {
  const token = process.env["GITHUB_DELIVERY_TOKEN"]?.trim()
  const allowlist = parseRepositoryAllowlist(process.env["GITHUB_DELIVERY_REPOSITORIES"])
  const apiUrl = process.env["GITHUB_DELIVERY_API_URL"]?.trim() || "https://api.github.com"
  // An invalid endpoint disables delivery rather than sending the token elsewhere.
  const usable = token && validProviderEndpoint(apiUrl)
  return { transport: usable ? fetchGitHubTransport(token, apiUrl.replace(/\/$/, "")) : null, allowed: allowlistAllows(allowlist) }
})

/** Fixture transport for tests and the CI acceptance flow. Records every write. */
export const fixtureGitHub = (seed: { owner: string; repo: string; branch: string; files: Record<string, string> }) => {
  let commitCounter = 0
  const sha40 = (s: string) => createHash("sha1").update(s).digest("hex")
  type Branch = { head: string; files: Map<string, string> }
  const branches = new Map<string, Branch>([[seed.branch, { head: sha40(`base-${seed.branch}`), files: new Map(Object.entries(seed.files)) }]])
  const prs: Array<{ number: number; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null }> = []
  const writes: string[] = []
  // Failure injection: throw before (or after) a named operation completes.
  const failures = new Map<string, { kind: GitHubErrorKind; after: boolean }>()
  const check = (op: string, phase: "before" | "after") => {
    const f = failures.get(op)
    if (f && f.after === (phase === "after")) { failures.delete(op); throw new GitHubError(f.kind, `fixture ${op} failure`) }
  }
  const known = (owner: string, repo: string) => owner.toLowerCase() === seed.owner.toLowerCase() && repo.toLowerCase() === seed.repo.toLowerCase()
  const toPr = (p: (typeof prs)[number]): GitHubPullRequest => ({
    number: p.number, url: `https://github.com/${seed.owner}/${seed.repo}/pull/${p.number}`, headSha: branches.get(p.head)?.head ?? "",
    state: p.state, merged: p.merged, mergeCommitSha: p.mergeCommitSha, mergedAt: p.merged ? "2026-10-19T00:00:00.000Z" : null, closedAt: p.state === "closed" ? "2026-10-19T00:00:00.000Z" : null,
  })
  const transport: GitHubTransport = {
    repository: async (owner, repo) => known(owner, repo) ? { defaultBranch: seed.branch } : null,
    branchHead: async (owner, repo, branch) => known(owner, repo) ? branches.get(branch)?.head ?? null : null,
    file: async (owner, repo, path, ref) => {
      if (!known(owner, repo)) return { kind: "missing" }
      const branch = [...branches.values()].find(b => b.head === ref) ?? branches.get(ref)
      const content = branch?.files.get(path)
      return content === undefined ? { kind: "missing" } : { kind: "file", blobSha: gitBlobSha(content), content }
    },
    createBranch: async (owner, repo, branch, fromSha) => {
      check("createBranch", "before")
      if (!known(owner, repo)) throw new GitHubError("NOT_FOUND", "repository")
      if (branches.has(branch)) return "exists"
      const from = [...branches.values()].find(b => b.head === fromSha)
      if (!from) throw new GitHubError("INVALID", "unknown base")
      branches.set(branch, { head: fromSha, files: new Map(from.files) })
      writes.push(`branch:${branch}`)
      check("createBranch", "after")
      return "created"
    },
    putFile: async (owner, repo, change) => {
      check("putFile", "before")
      const branch = branches.get(change.branch)
      if (!known(owner, repo) || !branch) throw new GitHubError("NOT_FOUND", "branch")
      const current = branch.files.get(change.path)
      if (current === undefined || gitBlobSha(current) !== change.expectedBlobSha) throw new GitHubError("CONFLICT", "blob changed")
      branch.files.set(change.path, change.content)
      branch.head = sha40(`commit-${++commitCounter}`)
      writes.push(`commit:${change.branch}:${change.path}`)
      check("putFile", "after")
      return { commitSha: branch.head }
    },
    findPullRequest: async (owner, repo, head, base) => {
      const found = known(owner, repo) ? prs.find(p => p.head === head && p.base === base) : undefined
      return found ? toPr(found) : null
    },
    createPullRequest: async (owner, repo, pr) => {
      check("createPullRequest", "before")
      if (!known(owner, repo) || !branches.has(pr.head)) throw new GitHubError("NOT_FOUND", "branch")
      if (prs.some(p => p.head === pr.head && p.state === "open")) throw new GitHubError("CONFLICT", "exists")
      const created = { number: prs.length + 1, head: pr.head, base: pr.base, title: pr.title, body: pr.body, state: "open" as const, merged: false, mergeCommitSha: null }
      prs.push(created)
      writes.push(`pr:${created.number}`)
      check("createPullRequest", "after")
      return toPr(created)
    },
    pullRequest: async (owner, repo, number) => {
      const found = known(owner, repo) ? prs.find(p => p.number === number) : undefined
      if (!found) throw new GitHubError("NOT_FOUND", "pull request")
      return toPr(found)
    },
  }
  return {
    transport, writes, prs, branches,
    failNext: (op: "createBranch" | "putFile" | "createPullRequest", kind: GitHubErrorKind, after = false) => { failures.set(op, { kind, after }) },
    /** Simulates someone else changing the file on the base branch. */
    editBase: (path: string, content: string) => {
      const base = branches.get(seed.branch)!
      base.files.set(path, content)
      base.head = sha40(`external-${++commitCounter}`)
    },
    merge: (number: number) => { const p = prs.find(x => x.number === number)!; p.state = "closed"; p.merged = true; p.mergeCommitSha = sha40(`merge-${number}`) },
    close: (number: number) => { const p = prs.find(x => x.number === number)!; p.state = "closed" },
  }
}

export const fixtureGitHubLayer = (fixture: ReturnType<typeof fixtureGitHub>, allowed: GitHubDeliveryConfig["allowed"]) =>
  Layer.succeed(GitHubDelivery, { transport: fixture.transport, allowed })

export const githubEffect = <A>(f: () => Promise<A>) => Effect.tryPromise({
  try: f,
  catch: e => e instanceof GitHubError ? e : new GitHubError("UNAVAILABLE", "GitHub request failed"),
})
