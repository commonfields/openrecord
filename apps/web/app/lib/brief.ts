// The weekly growth brief: the latest one for a business, writing a new one
// now, and turning the weekly schedule on or off.
import { api } from "./api"

export type Brief = {
  id: string; status: "RUNNING" | "READY" | "FAILED"; trigger: "SCHEDULE" | "MANUAL"
  text: string | null; decisions: Array<{ type: "GROWTH_OPPORTUNITY" | "AGENT_PROPOSAL"; id: string }>; conversationId: string | null
  provider: string | null; model: string | null; failure: string | null; startedAt: string; finishedAt: string | null
}
export type BriefSchedule = { enabled: boolean; nextRunAt: string }
const base = (id: string) => `/api/businesses/${encodeURIComponent(id)}/brief`
export const Briefs = {
  get: (businessId: string) => api<{ brief: Brief | null; previous: Brief | null; schedule: BriefSchedule }>(base(businessId)),
  run: (businessId: string) => api<{ brief: Brief }>(`${base(businessId)}/run`, { method: "POST", body: "{}" }),
  schedule: (businessId: string, enabled: boolean) => api<{ schedule: BriefSchedule }>(`${base(businessId)}/schedule`, { method: "POST", body: JSON.stringify({ enabled }) }),
}

/** Why a brief couldn't be written, in plain words. */
export const briefFailure = (code: string | null) =>
  code === "MODEL_UNCONFIGURED" ? "No model is available to write it. Connect a model in Settings, then try again."
  : code === "MODEL_RATE_LIMITED" ? "The model's usage limit was reached. It will try again next week, or try now later."
  : code?.startsWith("MODEL_") ? "The model didn't finish writing it. Try again."
  : "It couldn't be written this time. Try again."
