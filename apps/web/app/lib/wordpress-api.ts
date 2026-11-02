// The WordPress connection and its changes, kept apart from api.ts so the
// language guards on discovery copy (which must never claim publication)
// still apply there; WordPress changes really are published.
import { api } from "./api"

/** A change to a connected WordPress site: prepared, approved by a person, then published. */
export type WordPressValues = { title?: string; content?: string; meta?: Record<string, string>; status?: string }
export type WordPressChange = {
  id: string; kind: "UPDATE_COPY" | "SET_SEO" | "ADD_FAQ" | "CREATE_POST"; postType: "posts" | "pages"; postId: number | null
  targetTitle: string; targetLink: string | null; before: WordPressValues; after: WordPressValues; rationale: string
  status: "PROPOSED" | "PUBLISHING" | "PUBLISHED" | "REJECTED" | "FAILED" | "UNDONE"; proposedBy: "ASSISTANT" | "OPERATOR"
  failure: string | null; publishedLink: string | null; liveCheck: { status: number | null; observed: boolean | null } | null; createdAt: string; decidedAt: string | null
}
export type WordPressConnection = { siteUrl: string; username: string; last4: string; seoPlugin: "YOAST" | "RANK_MATH" | "NONE"; canPublish: boolean
  canAddScripts: boolean; siteName: string; status: "ACTIVE" | "REVOKED"; connectedAt: string }
const wpBase = (businessId: string) => `/api/businesses/${encodeURIComponent(businessId)}/wordpress`
export const WordPress = {
  status: (businessId: string) => api<{ configured: boolean; connection: WordPressConnection | null }>(wpBase(businessId)),
  connect: (businessId: string, siteUrl: string, username: string, appPassword: string) =>
    api<{ connection: WordPressConnection }>(wpBase(businessId), { method: "POST", body: JSON.stringify({ siteUrl, username, appPassword }) }),
  disconnect: (businessId: string) => api<{ disconnected: boolean }>(wpBase(businessId), { method: "DELETE" }),
  change: (businessId: string, id: string) => api<{ change: WordPressChange }>(`${wpBase(businessId)}/changes/${encodeURIComponent(id)}`),
  approve: (businessId: string, id: string) => api<{ change: WordPressChange }>(`${wpBase(businessId)}/changes/${encodeURIComponent(id)}/approve`, { method: "POST", body: "{}" }),
  reject: (businessId: string, id: string) => api<{ change: WordPressChange }>(`${wpBase(businessId)}/changes/${encodeURIComponent(id)}/reject`, { method: "POST", body: "{}" }),
  undo: (businessId: string, id: string) => api<{ change: WordPressChange }>(`${wpBase(businessId)}/changes/${encodeURIComponent(id)}/undo`, { method: "POST", body: "{}" }),
}
