import type { ChannelInventory, SetupConfirmInput, SetupView } from "@openrecord/contracts"
import { api, ApiError } from "./api"

export type { ChannelEntry, ChannelInventory, SetupView } from "@openrecord/contracts"

const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) })
const base = (businessId: string) => `/api/businesses/${encodeURIComponent(businessId)}`

export const Setup = {
  start: (input: { websiteUrl: string; goalStatement?: string | null; businessId?: string | null }) =>
    post<{ setup: SetupView; created: boolean }>("/api/setup", input),
  get: (businessId: string) => api<{ setup: SetupView | null }>(`${base(businessId)}/setup`),
  confirm: (businessId: string, input: SetupConfirmInput) => post<{ setup: SetupView }>(`${base(businessId)}/setup/confirm`, input),
  reviewChannels: (businessId: string, expectedRevision: number) => post<{ setup: SetupView }>(`${base(businessId)}/setup/channels`, { expectedRevision }),
  retry: (businessId: string, expectedRevision: number) => post<{ setup: SetupView }>(`${base(businessId)}/setup/retry`, { expectedRevision }),
  propose: (businessId: string, expectedRevision: number) => post<{ setup: SetupView }>(`${base(businessId)}/setup/propose`, { expectedRevision }),
}

export const Channels = {
  get: (businessId: string) => api<{ inventory: ChannelInventory }>(`${base(businessId)}/channels`),
}

/** Accepts "acme.com" as well as a full URL; returns null when it is not a web address. */
export const normalizeWebsite = (raw: string): string | null => {
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
    if (!url.hostname.includes(".") || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

export const setupError = (e: unknown): string => {
  if (e instanceof ApiError) {
    const reason = e.body["reason"]
    if (reason === "SetupStale") return "This changed in another tab. Reload to continue."
    if (reason === "WebsiteInUse") return "Another business in this workspace already uses that website."
    if (reason === "DiscoveryPending") return "Still reading the website. Try again in a moment."
    if (reason === "FactsManagedByRepository") return "This business's facts are managed from a repository, so they can't be set here."
    if (e.status === 422) return "Check the highlighted fields and try again."
  }
  return "Something went wrong. Try again."
}
