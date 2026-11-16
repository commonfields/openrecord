import { createPrivateKey, createSign } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect, Layer, Schema } from "effect"
import { GitHubError, GitHubExecution, GitHubExecutionLive, fetchGitHubTransport, githubEffect } from "./github.js"

export const githubAppConfig = () => {
  const appId = process.env["GITHUB_APP_ID"] ?? ""
  const clientId = process.env["GITHUB_APP_CLIENT_ID"] ?? ""
  const clientSecret = process.env["GITHUB_APP_CLIENT_SECRET"] ?? ""
  const slug = process.env["GITHUB_APP_SLUG"] ?? ""
  const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"]?.replace(/\\n/g, "\n") ?? ""
  const callbackUrl = process.env["GITHUB_APP_CALLBACK_URL"] ?? ""
  try {
    const url = new URL(callbackUrl)
    if (!/^[1-9][0-9]*$/.test(appId) || !clientId || !clientSecret || !/^[a-z0-9-]+$/.test(slug)
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash || url.pathname !== "/api/github/callback"
      || createPrivateKey(privateKey).asymmetricKeyType !== "rsa") return null
    return { appId, clientId, clientSecret, slug, privateKey, callbackUrl }
  } catch { return null }
}
export type GitHubAppConfig = NonNullable<ReturnType<typeof githubAppConfig>>
export const appJwt = (config: GitHubAppConfig, now = Date.now()) => {
  const part = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url")
  const payload = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540, iss: config.appId })}`
  return `${payload}.${createSign("RSA-SHA256").update(payload).sign(config.privateKey, "base64url")}`
}

/** All credential-bearing calls use fixed GitHub origins, bounded responses, no redirects. */
export const appRequest = async (path: string, token: string, body?: unknown): Promise<unknown> => {
  const response = await fetch(`https://api.github.com${path}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "openrecord", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    const retry = Number(response.headers.get("retry-after"))
    const limited = response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || retry > 0))
    throw new GitHubError(limited ? "RATE_LIMITED" : response.status === 401 || response.status === 403 ? "AUTH" : response.status === 404 ? "NOT_FOUND" : "UNAVAILABLE", "GitHub request refused", limited && retry > 0 ? Math.min(retry, 3600) : null)
  }
  return boundedJson(response)
}
export const boundedJson = async (response: Response): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (!reader) throw new GitHubError("INVALID", "Empty GitHub response")
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 2_000_000) throw new GitHubError("INVALID", "GitHub response too large")
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally { await reader.cancel() }
}
const InstallationToken = Schema.Struct({ token: Schema.NonEmptyString, permissions: Schema.Struct({ contents: Schema.Literal("write"), pull_requests: Schema.Literal("write") }) })
export const installationToken = async (config: GitHubAppConfig, installationId: string, repositoryId: string) => {
  const result = await appRequest(`/app/installations/${installationId}/access_tokens`, appJwt(config), {
    repository_ids: [Number(repositoryId)], permissions: { contents: "write", pull_requests: "write" },
  })
  return Schema.decodeUnknownSync(InstallationToken)(result).token
}

/** Resolve afresh for each operation; tokens are limited to exactly one repository. */
export const GitHubInstallationExecutionLive = Layer.unwrapEffect(Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const legacy = yield* GitHubExecution.pipe(Effect.provide(GitHubExecutionLive))
  const resolve = (owner: string, repository: string, accountId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT r.installation_id, r.repository_id, i.disconnected_at FROM github_installation_repositories r
      JOIN github_installations i USING (installation_id, account_id)
      WHERE r.account_id = ${accountId} AND lower(r.full_name) = lower(${`${owner}/${repository}`})`
      .pipe(Effect.mapError(() => new GitHubError("UNAVAILABLE", "Repository access unavailable")))
    if (!rows.length) return legacy.allowed(owner, repository, accountId) ? legacy.transport : null
    if (rows[0]!["disconnected_at"] !== null) return null
    const config = githubAppConfig()
    if (!config) return null
    const token = yield* githubEffect(() => installationToken(config, String(rows[0]!["installation_id"]), String(rows[0]!["repository_id"])))
    return fetchGitHubTransport(token)
  })
  return Layer.succeed(GitHubExecution, { ...legacy, resolve, appConfigured: githubAppConfig() !== null })
}))
