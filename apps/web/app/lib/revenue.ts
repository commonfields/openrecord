// Revenue client: the business's Stripe connection (a restricted read-only
// key it pastes in) and live revenue for a window and the one before.
import type { AdPerformanceDays, RevenueConnection, RevenuePerformance } from "@openrecord/contracts"
import { api, ApiError } from "./api"

const base = (id: string) => `/api/revenue/clients/${encodeURIComponent(id)}`
export const Revenue = {
  status: (businessId: string) => api<{ configured: boolean; connection: RevenueConnection | null }>(base(businessId)),
  connect: (businessId: string, key: string) => api<{ connection: RevenueConnection }>(`${base(businessId)}/stripe`, { method: "POST", body: JSON.stringify({ key }) }),
  disconnect: (businessId: string) => api<{ disconnected: true }>(`${base(businessId)}/stripe/disconnect`, { method: "POST", body: "{}" }),
  performance: (businessId: string, days: AdPerformanceDays) => api<{ revenue: RevenuePerformance | null }>(`${base(businessId)}/performance?days=${days}`),
}

export const revenueError = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "The request failed. Try again."
  const reason = typeof err.body["reason"] === "string" ? err.body["reason"] : ""
  const copy: Record<string, string> = {
    SecretKeyRefused: "That's a full secret key, which could charge and refund. OpenRecord doesn't keep it. Create a restricted key with read-only access instead.",
    NotARestrictedKey: "That doesn't look like a Stripe restricted key. It starts with rk_live_ (or rk_test_ for test mode).",
    KeyInvalid: "Stripe didn't accept that key. Check it was copied in full.",
    KeyCannotReadCharges: "That key can't read charges. Edit it in Stripe and set Charges to Read, then try again.",
    RevenueKeyRefused: "Stripe no longer accepts the connected key. Paste a new restricted key to continue.",
    RevenueNotConfigured: "Payment accounts can't be connected on this server yet (it needs a token encryption key).",
    ProviderQuota: "Stripe's rate limit was reached. Try again in a minute.",
    ProviderUnavailable: "Stripe didn't answer. Try again later.",
  }
  return copy[reason] ?? `The request was refused (${reason || err.tag}).`
}
