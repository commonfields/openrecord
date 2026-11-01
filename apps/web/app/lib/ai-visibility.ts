// External AI-visibility client: the business's read-only project key for an
// AI-visibility service the operator configured. The key is sent once to be
// checked and stored encrypted on the server; it is never read back.
import { api, ApiError } from "./api"

export interface AiVisibilityStatus { available: boolean; connected: boolean; projectName: string | null; keyHint: string | null; connectedAt: string | null }
const base = (id: string) => `/api/businesses/${encodeURIComponent(id)}/ai-visibility`
export const AiVisibility = {
  status: (businessId: string) => api<AiVisibilityStatus>(base(businessId)),
  connect: (businessId: string, apiKey: string) => api<AiVisibilityStatus>(base(businessId), { method: "PUT", body: JSON.stringify({ apiKey }) }),
  disconnect: (businessId: string) => api<AiVisibilityStatus>(base(businessId), { method: "DELETE" }),
}

export const aiVisibilityError = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "The request failed. Try again."
  const reason = typeof err.body["reason"] === "string" ? err.body["reason"] : ""
  const copy: Record<string, string> = {
    ORGANIZATION_KEY: "That key can read every project in the organization. Create a key for this one project instead.",
    NOT_READ_ONLY: "That key can change the project. Create a read-only key instead; OpenRecord only reads.",
    AUTH: "The service didn't accept that key. Check it was copied in full.",
    RATE_LIMITED: "The service's rate limit was reached. Try again in a minute.",
    UNAVAILABLE: "The service didn't answer. Try again later.",
    NOT_CONFIGURED: "AI-visibility projects can't be connected on this server yet.",
  }
  return copy[reason] ?? `The request was refused (${reason || err.tag}).`
}
