// LinkedIn: posting to a company page or a member's own profile, and reading
// how page posts did. Everything a post does goes through account-actions.ts,
// where a person approves the exact text first.
//
// Two kinds of access, from two LinkedIn products on the app:
//   - a member's own profile: "Share on LinkedIn" (self-serve) grants
//     w_member_social; "Sign in with LinkedIn using OpenID Connect" grants
//     openid and profile, which name the member;
//   - company pages the member administers: the Community Management API
//     (LinkedIn reviews the app) grants w_organization_social,
//     r_organization_social and rw_organization_admin. Only pages have
//     post statistics; LinkedIn offers none for a member's own posts.
// LINKEDIN_ORGANIZATIONS=1 asks for the page scopes; leave it off until
// LinkedIn has approved the app, or sign-in fails for every scope.
//
// Tokens last 60 days and LinkedIn gives most apps no refresh token, so the
// person signs in again, as with Meta. Post text is LinkedIn's "little text"
// format: its reserved characters are escaped so a stray "(" or "@" never
// breaks a post or turns into a mention, and #words become hashtags.
import type { AdAccount } from "@openrecord/contracts"
import { unexpected } from "./errors.js"
import { send, sendWithHeaders, text, type FetchLike } from "./http.js"

export const LINKEDIN_MEMBER_SCOPES = ["openid", "profile", "w_member_social"] as const
export const LINKEDIN_ORGANIZATION_SCOPES = ["w_organization_social", "r_organization_social", "rw_organization_admin"] as const
export const LINKEDIN_ACCEPTED_SCOPES: ReadonlyArray<string> = [...LINKEDIN_MEMBER_SCOPES, ...LINKEDIN_ORGANIZATION_SCOPES, "email"]
/** LinkedIn's limit on a post's text. */
export const LINKEDIN_POST_MAX = 3000

export interface LinkedInConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  /** The Marketing API version, YYYYMM. LinkedIn supports each for at least a year. */
  readonly version: string
  /** Whether the app has the Community Management API, so page scopes may be asked for. */
  readonly organizations: boolean
  readonly endpoints: { readonly authorize: string; readonly token: string; readonly api: string }
  readonly fetch: FetchLike
}
export const LINKEDIN_ENDPOINTS = {
  authorize: "https://www.linkedin.com/oauth/v2/authorization",
  token: "https://www.linkedin.com/oauth/v2/accessToken",
  api: "https://api.linkedin.com",
}

export const linkedinScopes = (c: Pick<LinkedInConfig, "organizations">): ReadonlyArray<string> =>
  c.organizations ? [...LINKEDIN_MEMBER_SCOPES, ...LINKEDIN_ORGANIZATION_SCOPES] : [...LINKEDIN_MEMBER_SCOPES]

const headers = (c: LinkedInConfig, token: string, json = false): Record<string, string> => ({
  authorization: `Bearer ${token}`, "linkedin-version": c.version, "x-restli-protocol-version": "2.0.0", accept: "application/json",
  ...(json ? { "content-type": "application/json" } : {}),
})
const rest = (c: LinkedInConfig, path: string) => `${c.endpoints.api}/rest${path}`

export const linkedinAuthorizationUrl = (c: LinkedInConfig, state: string) => `${c.endpoints.authorize}?${new URLSearchParams({
  response_type: "code", client_id: c.clientId, redirect_uri: c.redirectUri, state, scope: linkedinScopes(c).join(" "),
})}`

export interface LinkedInTokens { readonly accessToken: string; readonly expiresAt: number | null; readonly refreshToken: string | null; readonly scopes: ReadonlyArray<string> }

export const linkedinExchangeCode = async (c: LinkedInConfig, code: string, now = Date.now()): Promise<LinkedInTokens> => {
  const body = await send(c.fetch, c.endpoints.token, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri }).toString(),
  }) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; scope?: unknown }
  if (typeof body.access_token !== "string" || !body.access_token) throw unexpected()
  const expires = Number(body.expires_in)
  const scopes = typeof body.scope === "string" ? body.scope.split(/[\s,]+/).filter(Boolean).sort() : []
  return { accessToken: body.access_token, expiresAt: Number.isFinite(expires) && expires > 0 ? now + expires * 1000 : null,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null, scopes }
}

/** The signed-in member, from OpenID Connect userinfo: `sub` is their person id. */
export const linkedinIdentity = async (c: LinkedInConfig, token: string) => {
  const me = await send(c.fetch, `${c.endpoints.api}/v2/userinfo`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } }) as { sub?: unknown; name?: unknown }
  if (typeof me.sub !== "string" || !PERSON_ID.test(me.sub)) throw unexpected()
  return { subject: me.sub, name: text(me.name, 200) || "LinkedIn member" }
}

const PERSON_ID = /^[A-Za-z0-9_-]{1,64}$/
const ORG_URN = /^urn:li:organization:(\d{1,30})$/
export const LINKEDIN_AUTHOR = /^urn:li:(organization:\d{1,30}|person:[A-Za-z0-9_-]{1,64})$/
export const isOrganizationUrn = (urn: string) => ORG_URN.test(urn)

// Roles that may post for a page; statistics need ADMINISTRATOR.
const POSTING_ROLES = new Set(["ADMINISTRATOR", "CONTENT_ADMIN", "DIRECT_SPONSORED_CONTENT_POSTER"])

/**
 * Where this sign-in may post: the member's own profile, and with page
 * access the pages they administer. Each comes back as an AdAccount whose
 * externalId is the author URN.
 */
export const linkedinAuthors = async (c: LinkedInConfig, token: string, member: { subject: string; name: string }, scopes: ReadonlyArray<string>): Promise<ReadonlyArray<AdAccount>> => {
  const own: AdAccount[] = scopes.includes("w_member_social")
    ? [{ externalId: `urn:li:person:${member.subject}`, name: `${member.name} (profile)`, currency: null, loginCustomerId: null, active: true }] : []
  if (!scopes.includes("w_organization_social")) return own
  const acls = await send(c.fetch, `${rest(c, "/organizationAcls")}?q=roleAssignee&state=APPROVED&count=100&start=0`, { method: "GET", headers: headers(c, token) }) as { elements?: Array<Record<string, unknown>> }
  const ids = [...new Set((acls.elements ?? []).flatMap(e => {
    const urn = text(e["organization"] ?? e["organizationTarget"], 80)
    const id = ORG_URN.exec(urn)?.[1]
    return id && POSTING_ROLES.has(text(e["role"], 40)) ? [id] : []
  }))].slice(0, 50)
  const pages = await Promise.all(ids.map(async (id): Promise<AdAccount> => {
    const org = await send(c.fetch, rest(c, `/organizations/${id}`), { method: "GET", headers: headers(c, token) }).catch(() => ({})) as { localizedName?: unknown }
    return { externalId: `urn:li:organization:${id}`, name: text(org.localizedName, 200) || `LinkedIn page ${id}`, currency: null, loginCustomerId: null, active: true }
  }))
  return [...pages.sort((a, b) => a.name.localeCompare(b.name)), ...own]
}

// ---- post text ----------------------------------------------------------------

// LinkedIn's little text format reserves these; each is escaped with a backslash.
const RESERVED = /[\\|{}@[\]()<>#*_~]/g

/**
 * Plain text as LinkedIn commentary: reserved characters escaped, and each
 * #word kept as a hashtag. What is shown on LinkedIn is the plain text.
 */
export const linkedinCommentary = (plain: string): string => {
  const out: string[] = []
  let last = 0
  for (const m of plain.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,100})/gu)) {
    const start = m.index! + m[1]!.length
    out.push(plain.slice(last, start).replace(RESERVED, ch => `\\${ch}`))
    out.push(`{hashtag|\\#|${m[2]!.replace(RESERVED, ch => `\\${ch}`)}}`)
    last = start + 1 + m[2]!.length
  }
  out.push(plain.slice(last).replace(RESERVED, ch => `\\${ch}`))
  return out.join("")
}

// ---- posts -------------------------------------------------------------------

export const POST_URN = /^urn:li:(share|ugcPost):\d{1,30}$/
const encodeUrn = (urn: string) => encodeURIComponent(urn)

/** Publishes one public text post now and returns its URN. */
export const linkedinCreatePost = async (c: LinkedInConfig, token: string, author: string, plain: string): Promise<string> => {
  if (!LINKEDIN_AUTHOR.test(author) || !plain.trim() || plain.length > LINKEDIN_POST_MAX) throw unexpected()
  const { headers: h } = await sendWithHeaders(c.fetch, rest(c, "/posts"), {
    method: "POST", headers: headers(c, token, true),
    body: JSON.stringify({
      author, commentary: linkedinCommentary(plain), visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
    }),
  })
  const urn = h.get("x-restli-id") ?? ""
  if (!POST_URN.test(urn)) throw unexpected()
  return urn
}

/** A post as LinkedIn holds it now, or null when it no longer exists. */
export const linkedinGetPost = async (c: LinkedInConfig, token: string, urn: string): Promise<{ readonly author: string; readonly commentary: string; readonly lifecycleState: string } | null> => {
  if (!POST_URN.test(urn)) throw unexpected()
  try {
    const p = await send(c.fetch, `${rest(c, `/posts/${encodeUrn(urn)}`)}?viewContext=AUTHOR`, { method: "GET", headers: headers(c, token) }) as Record<string, unknown>
    return { author: text(p["author"], 120), commentary: typeof p["commentary"] === "string" ? p["commentary"] : "", lifecycleState: text(p["lifecycleState"], 40) }
  } catch (e) {
    if (e instanceof Error && "kind" in e && (e as { kind: string }).kind === "NOT_FOUND") return null
    throw e
  }
}

/** Deletes a post. LinkedIn treats a second delete as done. */
export const linkedinDeletePost = async (c: LinkedInConfig, token: string, urn: string): Promise<void> => {
  if (!POST_URN.test(urn)) throw unexpected()
  await send(c.fetch, rest(c, `/posts/${encodeUrn(urn)}`), { method: "DELETE", headers: { ...headers(c, token), "x-restli-method": "DELETE" } })
}

export interface LinkedInPostStats {
  readonly impressions: number; readonly uniqueImpressions: number; readonly clicks: number
  readonly likes: number; readonly comments: number; readonly shares: number
  /** LinkedIn's own rate: organic clicks, likes, comments and shares over impressions. */
  readonly engagement: number
}
const ZERO: LinkedInPostStats = { impressions: 0, uniqueImpressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, engagement: 0 }
const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0

/**
 * Lifetime organic statistics of a page's posts (sponsored activity is not
 * counted; LinkedIn keeps a rolling 12 months). A post with no activity is
 * absent from LinkedIn's answer and comes back as zeros.
 */
export const linkedinPostStats = async (c: LinkedInConfig, token: string, organization: string, posts: ReadonlyArray<string>): Promise<ReadonlyMap<string, LinkedInPostStats>> => {
  if (!ORG_URN.test(organization)) throw unexpected()
  const valid = posts.filter(p => POST_URN.test(p)).slice(0, 50)
  const shares = valid.filter(p => p.startsWith("urn:li:share:")), ugc = valid.filter(p => p.startsWith("urn:li:ugcPost:"))
  const out = new Map<string, LinkedInPostStats>(valid.map(p => [p, ZERO]))
  const query = async (extra: string) => {
    const body = await send(c.fetch, `${rest(c, "/organizationalEntityShareStatistics")}?q=organizationalEntity&organizationalEntity=${encodeUrn(organization)}${extra}`,
      { method: "GET", headers: headers(c, token) }) as { elements?: Array<Record<string, unknown>> }
    for (const e of body.elements ?? []) {
      const urn = text(e["share"] ?? e["ugcPost"], 80)
      const t = (e["totalShareStatistics"] ?? {}) as Record<string, unknown>
      if (out.has(urn)) out.set(urn, { impressions: n(t["impressionCount"]), uniqueImpressions: n(t["uniqueImpressionsCount"] ?? t["uniqueImpressionsCounts"]), clicks: n(t["clickCount"]),
        likes: Math.max(0, n(t["likeCount"])), comments: n(t["commentCount"]), shares: n(t["shareCount"]), engagement: n(t["engagement"]) })
    }
  }
  if (shares.length) await query(`&shares=List(${shares.map(encodeUrn).join(",")})`)
  if (ugc.length) await query(ugc.map((u, i) => `&ugcPosts[${i}]=${encodeUrn(u)}`).join(""))
  return out
}
