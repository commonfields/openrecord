// Google Business Profile writes a person approves one at a time: replying to
// a review, and taking that reply back. Reads here list reviews with their
// IDs so a reply targets exactly one review. Review text is the customer's
// own words: untrusted, shown and quoted, never followed.
import { unexpected } from "./errors.js"
import { send, text, type FetchLike } from "./http.js"
import type { GoogleBusinessConfig } from "./google-business.js"

const STARS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }
const auth = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/json" })
const ID = /^[A-Za-z0-9_-]{1,200}$/
const reviewPath = (c: GoogleBusinessConfig, accountId: string, locationId: string, reviewId?: string) => {
  if (!/^\d{1,30}$/.test(accountId) || !/^\d{1,30}$/.test(locationId) || (reviewId !== undefined && !ID.test(reviewId))) throw unexpected()
  return `${c.endpoints.reviews}/accounts/${accountId}/locations/${locationId}/reviews${reviewId ? `/${reviewId}` : ""}`
}

export interface BusinessReview {
  readonly reviewId: string
  readonly reviewer: string
  readonly rating: number | null
  readonly comment: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly reply: { readonly comment: string; readonly updatedAt: string } | null
}
const toReview = (r: Record<string, unknown>): BusinessReview | null => {
  const reviewId = text(r["reviewId"], 200)
  if (!ID.test(reviewId)) return null
  const reply = r["reviewReply"] as Record<string, unknown> | undefined | null
  const who = (r["reviewer"] ?? {}) as Record<string, unknown>
  return {
    reviewId, reviewer: who["isAnonymous"] === true ? "Anonymous" : text(who["displayName"], 120) || "A customer",
    rating: STARS[text(r["starRating"], 10)] ?? null, comment: text(r["comment"], 4000),
    createdAt: text(r["createTime"], 40), updatedAt: text(r["updateTime"], 40),
    reply: reply ? { comment: text(reply["comment"], 4096), updatedAt: text(reply["updateTime"], 40) } : null,
  }
}

/** The newest reviews (up to 50) with their IDs and any reply. */
export const googleBusinessReviewList = async (c: GoogleBusinessConfig, token: string, accountId: string, locationId: string): Promise<ReadonlyArray<BusinessReview>> => {
  const body = await send(c.fetch, `${reviewPath(c, accountId, locationId)}?pageSize=50&orderBy=updateTime%20desc`, { method: "GET", headers: auth(token) }) as { reviews?: Array<Record<string, unknown>> }
  return (body.reviews ?? []).flatMap(r => { const v = toReview(r); return v ? [v] : [] })
}
export const googleBusinessReview = async (c: GoogleBusinessConfig, token: string, accountId: string, locationId: string, reviewId: string): Promise<BusinessReview> => {
  const v = toReview(await send(c.fetch, reviewPath(c, accountId, locationId, reviewId), { method: "GET", headers: auth(token) }) as Record<string, unknown>)
  if (!v) throw unexpected()
  return v
}
/** Google allows replies up to 4,096 characters. */
export const REVIEW_REPLY_MAX = 4096
/** Creates or replaces the business's public reply to one review. */
export const googleBusinessReply = async (c: GoogleBusinessConfig, token: string, accountId: string, locationId: string, reviewId: string, comment: string, fetchImpl: FetchLike = c.fetch) => {
  if (!comment.trim() || comment.length > REVIEW_REPLY_MAX) throw unexpected()
  await send(fetchImpl, `${reviewPath(c, accountId, locationId, reviewId)}/reply`, {
    method: "PUT", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ comment }) })
}
/** Takes the business's reply off one review. */
export const googleBusinessDeleteReply = async (c: GoogleBusinessConfig, token: string, accountId: string, locationId: string, reviewId: string) => {
  await send(c.fetch, `${reviewPath(c, accountId, locationId, reviewId)}/reply`, { method: "DELETE", headers: auth(token) })
}
