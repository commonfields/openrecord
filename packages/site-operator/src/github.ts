// GitHub transport for connected execution (W7). The only provider operations
// OpenRecord performs: read a branch head, one file and one pull request,
// create one branch, commit one file, open one pull request. There is no
// merge, no workflow dispatch and no other write path: the repository's own
// maintainer merges. Credentials come from server configuration only and never
// appear in an error message, a log line or a response.
//
// Ported from the preserved W2 transport (commit ee80b91), extended with pull
// request file listing, repository identity and merge-commit reads so a merge
// can be verified against the exact authorized change.
import { createHash } from "node:crypto"
import { Context, Effect, Layer } from "effect"

export type GitHubErrorKind = "NOT_FOUND" | "CONFLICT" | "AUTH" | "RATE_LIMITED" | "INVALID" | "UNAVAILABLE" | "TIMEOUT"
export class GitHubError extends Error {
  constructor(readonly kind: GitHubErrorKind, message: string, readonly retryAfterSeconds: number | null = null) { super(message) }
}
/** Outcomes where the request may or may not have reached the provider. */
export const githubOutcomeUncertain = (e: GitHubError): boolean => e.kind === "TIMEOUT" || e.kind === "UNAVAILABLE"

export type GitHubFile =
  | { readonly kind: "file"; readonly blobSha: string; readonly content: string }
  | { readonly kind: "missing" }
  | { readonly kind: "not_file" }
  | { readonly kind: "too_large" }
  | { readonly kind: "not_text" }

export interface GitHubPullRequest {
  readonly number: number; readonly url: string; readonly headSha: string; readonly headRef: string; readonly baseRef: string
  /** owner/name of the repository the pull request targets, as the provider reports it. */
  readonly baseRepository: string; readonly headRepository: string
  readonly state: "open" | "closed"; readonly merged: boolean; readonly mergeCommitSha: string | null
  readonly mergedAt: string | null; readonly closedAt: string | null
}
export interface GitHubPullRequestFile { readonly path: string; readonly status: string }

export interface GitHubTransport {
  repository(owner: string, repo: string): Promise<{ readonly defaultBranch: string; readonly fullName: string } | null>
  branchHead(owner: string, repo: string, branch: string): Promise<string | null>
  file(owner: string, repo: string, path: string, ref: string): Promise<GitHubFile>
  createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<"created" | "exists">
  putFile(owner: string, repo: string, change: { path: string; branch: string; content: string; expectedBlobSha: string; message: string }): Promise<{ readonly commitSha: string }>
  findPullRequest(owner: string, repo: string, head: string, base: string): Promise<GitHubPullRequest | null>
  createPullRequest(owner: string, repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<GitHubPullRequest>
  pullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest>
  pullRequestFiles(owner: string, repo: string, number: number): Promise<ReadonlyArray<GitHubPullRequestFile>>
}

export const MAX_EXECUTION_FILE_BYTES = 256_000

/** Git's blob id: sha1("blob <bytes>\0<content>"). Lets the server compare content GitHub reports with the approved bytes. */
export const gitBlobSha = (content: string): string => {
  const bytes = Buffer.from(content, "utf8")
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
}
export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

// ---- the exact change ----

export const EXECUTION_PLAN_VERSION = "openrecord-execution-plan/1"
export interface ExecutionPlanBinding {
  readonly actionKind: string; readonly owner: string; readonly repository: string; readonly baseBranch: string; readonly baseCommitSha: string
  readonly filePath: string; readonly liveUrl: string; readonly beforeSha256: string; readonly afterSha256: string
}
/** What an approval binds to: repository, branch, base commit, page, live page and the exact before/after bytes. */
export const executionPatchSha256 = (p: ExecutionPlanBinding): string => sha256Text([
  EXECUTION_PLAN_VERSION, p.actionKind, `${p.owner}/${p.repository}`.toLowerCase(), p.baseBranch, p.baseCommitSha, p.filePath, p.liveUrl, p.beforeSha256, p.afterSha256,
].join("\n"))

/** One deterministic head branch per operation: replaying a dispatch can only ever reach the same branch. */
export const executionHeadBranch = (operationId: string): string => `openrecord/exec-${operationId}`
export const EXECUTION_HEAD_BRANCH = /^openrecord\/exec-[a-f0-9-]{36}$/

export const executionPullRequestText = (i: { operationId: string; filePath: string; patchSha256: string; diff: string; rationale: string; liveUrl: string }) => ({
  title: `Remove noindex from ${i.filePath}`,
  body: [
    "This pull request was opened by OpenRecord for a change a person reviewed and authorized.", "",
    `- Page: \`${i.filePath}\``, `- Live URL: ${i.liveUrl}`, `- OpenRecord execution: ${i.operationId}`, `- Approved patch: ${i.patchSha256}`, "",
    `Why: ${i.rationale}`, "", "```diff", i.diff, "```", "",
    "OpenRecord does not merge or deploy. Merging is the repository maintainer's decision. If you change this pull request, OpenRecord will not treat it as the approved change.",
  ].join("\n"),
  commitMessage: `Remove noindex from ${i.filePath}\n\nOpenRecord execution ${i.operationId}\nApproved patch ${i.patchSha256}`,
})

// ---- configuration ----

/** `owner/repo=<account id>`: a repository is usable only by the account it is listed for, whatever the database says. */
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

/** HTTPS, or an exact loopback address (a local GitHub stand-in for development). */
export const validGitHubEndpoint = (raw: string): boolean => {
  try {
    const u = new URL(raw)
    if (u.username || u.password || u.search || u.hash) return false
    if (u.protocol === "https:") return true
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
  } catch { return false }
}

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
          "user-agent": "openrecord-connected-execution", ...(body === undefined ? {} : { "content-type": "application/json" }),
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
    const retryAfter = Number(response.headers.get("retry-after"))
    if (response.status === 401 || response.status === 403) {
      const limited = response.headers.get("x-ratelimit-remaining") === "0" || (response.status === 403 && Number.isFinite(retryAfter) && retryAfter > 0)
      throw limited ? new GitHubError("RATE_LIMITED", "GitHub rate limit reached", Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null)
        : new GitHubError("AUTH", "GitHub refused the execution credentials")
    }
    if (response.status === 429) throw new GitHubError("RATE_LIMITED", "GitHub rate limit reached", Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null)
    if (response.status >= 500) throw new GitHubError("UNAVAILABLE", `GitHub returned ${response.status}`)
    return { status: response.status, json }
  }
  const obj = (v: unknown) => (v !== null && typeof v === "object" ? v as Record<string, unknown> : {})
  const toPr = (raw: unknown): GitHubPullRequest => {
    const pr = obj(raw), head = obj(pr["head"]), base = obj(pr["base"])
    const number = Number(pr["number"]), url = String(pr["html_url"] ?? "")
    if (!Number.isInteger(number) || !/^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+$/.test(url)) throw new GitHubError("INVALID", "unexpected pull request shape")
    return {
      number, url, headSha: String(head["sha"] ?? ""), headRef: String(head["ref"] ?? ""), baseRef: String(base["ref"] ?? ""),
      baseRepository: String(obj(base["repo"])["full_name"] ?? ""), headRepository: String(obj(head["repo"])["full_name"] ?? ""),
      state: pr["state"] === "closed" ? "closed" : "open", merged: pr["merged"] === true || typeof pr["merged_at"] === "string",
      mergeCommitSha: typeof pr["merge_commit_sha"] === "string" ? pr["merge_commit_sha"] : null,
      mergedAt: typeof pr["merged_at"] === "string" ? pr["merged_at"] : null, closedAt: typeof pr["closed_at"] === "string" ? pr["closed_at"] : null,
    }
  }
  const repoPath = (owner: string, repo: string) => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  return {
    repository: async (owner, repo) => {
      const r = await call("GET", repoPath(owner, repo))
      if (r.status === 404) return null
      return { defaultBranch: String(obj(r.json)["default_branch"] ?? ""), fullName: String(obj(r.json)["full_name"] ?? "") }
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
      if (Number(f["size"]) > MAX_EXECUTION_FILE_BYTES || f["encoding"] !== "base64") return { kind: "too_large" }
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
    pullRequestFiles: async (owner, repo, number) => {
      const r = await call("GET", `${repoPath(owner, repo)}/pulls/${number}/files?per_page=100`)
      if (r.status === 404) throw new GitHubError("NOT_FOUND", "pull request not found")
      if (!Array.isArray(r.json)) throw new GitHubError("INVALID", "unexpected pull request files shape")
      return r.json.map(f => ({ path: String(obj(f)["filename"] ?? ""), status: String(obj(f)["status"] ?? "") }))
    },
  }
}

// ---- fixture provider (tests and the CI acceptance flow; never a live provider) ----

export type FixtureOperation = "createBranch" | "putFile" | "createPullRequest" | "branchHead" | "file" | "pullRequest" | "findPullRequest"
/** An in-memory GitHub stand-in. Records every write. Passing tests against it is MOCK_ADAPTER_PASS, not live-provider validation. */
export const fixtureGitHub = (seed: { owner: string; repo: string; branch: string; files: Record<string, string> }) => {
  let counter = 0
  const sha40 = (s: string) => createHash("sha1").update(s).digest("hex")
  type Branch = { head: string; files: Map<string, string> }
  const branches = new Map<string, Branch>([[seed.branch, { head: sha40(`base-${seed.branch}`), files: new Map(Object.entries(seed.files)) }]])
  const commits = new Map<string, Map<string, string>>([[branches.get(seed.branch)!.head, new Map(Object.entries(seed.files))]])
  type Pr = { number: number; head: string; base: string; title: string; body: string; state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; mergedAt: string | null; baseRepository: string; changedPaths: string[] }
  const prs: Pr[] = []
  const writes: string[] = []
  let now = "2026-10-21T00:00:00.000Z"
  // Failure injection: throw before (or after) a named operation completes. `times` repeats it.
  const failures = new Map<string, { kind: GitHubErrorKind; after: boolean; times: number; retryAfter: number | null }>()
  const check = (op: FixtureOperation, phase: "before" | "after") => {
    const f = failures.get(op)
    if (f && f.after === (phase === "after")) {
      if (--f.times <= 0) failures.delete(op)
      throw new GitHubError(f.kind, `fixture ${op} failure`, f.retryAfter)
    }
  }
  const full = `${seed.owner}/${seed.repo}`
  const known = (owner: string, repo: string) => owner.toLowerCase() === seed.owner.toLowerCase() && repo.toLowerCase() === seed.repo.toLowerCase()
  const toPr = (p: Pr): GitHubPullRequest => ({
    number: p.number, url: `https://github.com/${full}/pull/${p.number}`, headSha: branches.get(p.head)?.head ?? "", headRef: p.head, baseRef: p.base,
    baseRepository: p.baseRepository, headRepository: full, state: p.state, merged: p.merged, mergeCommitSha: p.mergeCommitSha, mergedAt: p.mergedAt, closedAt: p.state === "closed" ? now : null,
  })
  const transport: GitHubTransport = {
    repository: async (owner, repo) => { check("branchHead", "before"); return known(owner, repo) ? { defaultBranch: seed.branch, fullName: full } : null },
    branchHead: async (owner, repo, branch) => { check("branchHead", "before"); return known(owner, repo) ? branches.get(branch)?.head ?? null : null },
    file: async (owner, repo, path, ref) => {
      check("file", "before")
      if (!known(owner, repo)) return { kind: "missing" }
      const files = commits.get(ref) ?? branches.get(ref)?.files
      const content = files?.get(path)
      return content === undefined ? { kind: "missing" } : { kind: "file", blobSha: gitBlobSha(content), content }
    },
    createBranch: async (owner, repo, branch, fromSha) => {
      check("createBranch", "before")
      if (!known(owner, repo)) throw new GitHubError("NOT_FOUND", "repository")
      if (branches.has(branch)) return "exists"
      const from = commits.get(fromSha)
      if (!from) throw new GitHubError("INVALID", "unknown base")
      branches.set(branch, { head: fromSha, files: new Map(from) })
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
      branch.head = sha40(`commit-${++counter}`)
      commits.set(branch.head, new Map(branch.files))
      writes.push(`commit:${change.branch}:${change.path}`)
      check("putFile", "after")
      return { commitSha: branch.head }
    },
    findPullRequest: async (owner, repo, head, base) => {
      check("findPullRequest", "before")
      const found = known(owner, repo) ? prs.find(p => p.head === head && p.base === base) : undefined
      return found ? toPr(found) : null
    },
    createPullRequest: async (owner, repo, pr) => {
      check("createPullRequest", "before")
      if (!known(owner, repo) || !branches.has(pr.head)) throw new GitHubError("NOT_FOUND", "branch")
      if (prs.some(p => p.head === pr.head && p.state === "open")) throw new GitHubError("CONFLICT", "exists")
      const baseFiles = branches.get(pr.base)!.files, headFiles = branches.get(pr.head)!.files
      const changedPaths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].filter(p => baseFiles.get(p) !== headFiles.get(p))
      const created: Pr = { number: prs.length + 1, head: pr.head, base: pr.base, title: pr.title, body: pr.body, state: "open", merged: false, mergeCommitSha: null, mergedAt: null, baseRepository: full, changedPaths }
      prs.push(created)
      writes.push(`pr:${created.number}`)
      check("createPullRequest", "after")
      return toPr(created)
    },
    pullRequest: async (owner, repo, number) => {
      check("pullRequest", "before")
      const found = known(owner, repo) ? prs.find(p => p.number === number) : undefined
      if (!found) throw new GitHubError("NOT_FOUND", "pull request")
      return toPr(found)
    },
    pullRequestFiles: async (owner, repo, number) => {
      const found = known(owner, repo) ? prs.find(p => p.number === number) : undefined
      if (!found) throw new GitHubError("NOT_FOUND", "pull request")
      const headFiles = branches.get(found.head)!.files, baseFiles = branches.get(found.base)!.files
      const paths = found.merged ? found.changedPaths : [...new Set([...baseFiles.keys(), ...headFiles.keys()])].filter(p => baseFiles.get(p) !== headFiles.get(p))
      return paths.map(path => ({ path, status: "modified" }))
    },
  }
  return {
    transport, writes, prs, branches,
    failNext: (op: FixtureOperation, kind: GitHubErrorKind, opts: { after?: boolean; times?: number; retryAfter?: number } = {}) => {
      failures.set(op, { kind, after: opts.after ?? false, times: opts.times ?? 1, retryAfter: opts.retryAfter ?? null })
    },
    /** Someone else changes a file on the base branch. */
    editBase: (path: string, content: string) => {
      const base = branches.get(seed.branch)!
      base.files.set(path, content)
      base.head = sha40(`external-${++counter}`)
      commits.set(base.head, new Map(base.files))
    },
    /** Someone pushes another change onto the pull request branch. */
    editPrBranch: (number: number, path: string, content: string) => {
      const p = prs.find(x => x.number === number)!, b = branches.get(p.head)!
      b.files.set(path, content)
      b.head = sha40(`pr-edit-${++counter}`)
      commits.set(b.head, new Map(b.files))
    },
    /** The maintainer merges: the base branch takes the head branch's files and gets a merge commit. */
    merge: (number: number, opts: { mergedAt?: string } = {}) => {
      const p = prs.find(x => x.number === number)!, base = branches.get(p.base)!, head = branches.get(p.head)!
      p.changedPaths = [...new Set([...base.files.keys(), ...head.files.keys()])].filter(k => base.files.get(k) !== head.files.get(k))
      for (const k of p.changedPaths) { const v = head.files.get(k); if (v === undefined) base.files.delete(k); else base.files.set(k, v) }
      base.head = sha40(`merge-${number}-${++counter}`)
      commits.set(base.head, new Map(base.files))
      p.state = "closed"; p.merged = true; p.mergeCommitSha = base.head; p.mergedAt = opts.mergedAt ?? now
    },
    close: (number: number) => { prs.find(x => x.number === number)!.state = "closed" },
    setBaseRepository: (number: number, fullName: string) => { prs.find(x => x.number === number)!.baseRepository = fullName },
    setClock: (iso: string) => { now = iso },
  }
}

// ---- configuration service ----

export interface GitHubExecutionConfig {
  /** Null when no token is configured: execution is refused, never simulated. */
  readonly transport: GitHubTransport | null
  /** Per-account repository allowlist. The caller also applies the OpenRecord-repository denial. */
  readonly allowed: (owner: string, repo: string, accountId: string) => boolean
}
export class GitHubExecution extends Context.Tag("GitHubExecution")<GitHubExecution, GitHubExecutionConfig>() {}

/**
 *   GITHUB_EXECUTION_TOKEN         a fine-grained token limited to the selected
 *                                  repositories (Contents and Pull requests: read and write).
 *   GITHUB_EXECUTION_REPOSITORIES  comma-separated owner/repo=<account id>.
 *   GITHUB_EXECUTION_API_URL       optional; HTTPS or an exact loopback address.
 * An invalid endpoint disables execution rather than sending the token elsewhere.
 */
export const GitHubExecutionLive = Layer.sync(GitHubExecution, () => {
  const token = process.env["GITHUB_EXECUTION_TOKEN"]?.trim()
  const allowlist = parseRepositoryAllowlist(process.env["GITHUB_EXECUTION_REPOSITORIES"])
  const apiUrl = process.env["GITHUB_EXECUTION_API_URL"]?.trim() || "https://api.github.com"
  const usable = token && validGitHubEndpoint(apiUrl)
  return { transport: usable ? fetchGitHubTransport(token, apiUrl.replace(/\/$/, "")) : null, allowed: allowlistAllows(allowlist) }
})
export const fixtureGitHubLayer = (fixture: ReturnType<typeof fixtureGitHub>, allowed: GitHubExecutionConfig["allowed"]) =>
  Layer.succeed(GitHubExecution, { transport: fixture.transport, allowed })

export const githubEffect = <A>(f: () => Promise<A>) => Effect.tryPromise({
  try: f,
  catch: e => e instanceof GitHubError ? e : new GitHubError("UNAVAILABLE", "GitHub request failed"),
})
