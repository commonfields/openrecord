// Artifacts: finished pieces of work the agent wrote for a business (a landing
// page, an article, an email, ad copy, a brief), kept with every version.
import { api } from "@/lib/api"

export type ArtifactKind = "LANDING_PAGE" | "ARTICLE" | "EMAIL" | "AD_COPY" | "SOCIAL_POST" | "BRIEF" | "REPORT" | "OTHER"
export type ArtifactFormat = "HTML" | "MARKDOWN"
/** What a chat reply carries for each artifact its run saved. */
export type ArtifactRef = { id: string; title: string; kind: ArtifactKind; format: ArtifactFormat; version: number }
export type ArtifactSummary = ArtifactRef & { createdAt: string; updatedAt: string; chars: number }
export type ArtifactVersion = { version: number; title: string; note: string | null; source: "ASSISTANT" | "OPERATOR"; createdAt: string; chars: number }
export type Artifact = ArtifactSummary & { content: string; shownVersion: number; versions: ArtifactVersion[] }

export const ARTIFACT_KIND_LABEL: Readonly<Record<ArtifactKind, string>> = {
  LANDING_PAGE: "Landing page", ARTICLE: "Article", EMAIL: "Email", AD_COPY: "Ad copy", SOCIAL_POST: "Social post", BRIEF: "Brief", REPORT: "Report", OTHER: "Document",
}

const base = (businessId: string) => `/api/businesses/${encodeURIComponent(businessId)}/artifacts`
export const artifactsKey = (businessId: string) => `artifacts:${businessId}`
/** The artifact as a page. The server sandboxes it: no scripts, no forms, no requests but images, styles and fonts. */
export const artifactPreviewPath = (businessId: string, artifactId: string, version?: number, download = false) => {
  const query = new URLSearchParams({ ...(version ? { version: String(version) } : {}), ...(download ? { download: "1" } : {}) }).toString()
  return `${base(businessId)}/${encodeURIComponent(artifactId)}/preview${query ? `?${query}` : ""}`
}
export const Artifacts = {
  list: (businessId: string) => api<{ artifacts: ArtifactSummary[] }>(base(businessId)),
  read: (businessId: string, artifactId: string, version?: number) =>
    api<{ artifact: Artifact }>(`${base(businessId)}/${encodeURIComponent(artifactId)}${version ? `?version=${version}` : ""}`),
  save: (businessId: string, artifactId: string, body: { baseVersion: number; content?: string; title?: string; note?: string }) =>
    api<{ artifact: Artifact }>(`${base(businessId)}/${encodeURIComponent(artifactId)}`, { method: "POST", body: JSON.stringify(body) }),
  archive: (businessId: string, artifactId: string) => api<{ archived: true }>(`${base(businessId)}/${encodeURIComponent(artifactId)}/archive`, { method: "POST", body: "{}" }),
  link: (businessId: string, artifactId: string) => api<{ path: string; expiresAt: string }>(`${base(businessId)}/${encodeURIComponent(artifactId)}/links`, { method: "POST", body: "{}" }),
}

const listeners = new Set<() => void>()
/** Tells open lists that an artifact was saved, so they read again. */
export const notifyArtifactsChanged = () => { for (const listener of listeners) listener() }
export const onArtifactsChanged = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
