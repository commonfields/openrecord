import { generatePath } from "react-router"
import { EvidenceRoutePatterns } from "./route-patterns"
import type { AgentCitation } from "./api"
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
// Never navigate to model-supplied URLs. Targets correspond to authenticated app routes.
export const agentEvidencePath = (businessId: string, citation: AgentCitation): string | null => {
  if (!uuid.test(businessId) || !uuid.test(citation.id)) return null
  const base = `/businesses/${businessId}`
  switch (citation.kind) {
    case "observation": return generatePath(EvidenceRoutePatterns.observation, { observationId: citation.id })
    case "issue": return `${base}/issues/${citation.id}`
    case "fact": return `${base}/truth`
    case "question": return `${base}/checks`
    case "representation": return `${base}/representations/${citation.id}`
    case "discovery_scope": return `${base}/${EvidenceRoutePatterns.sourceDiscovery}`
    case "referral_import": return `/clients/${businessId}/discovery/report`
    case "acquisition_batch": return `/clients/${businessId}/discovery?batchId=${citation.id}`
    case "acquisition": return `/clients/${businessId}/discovery`
    case "growth_goal": return `/clients/${businessId}/growth`
    case "growth_opportunity": return `/clients/${businessId}/growth#opportunity-${citation.id}`
    case "record": return `/clients/${businessId}`
    case "search_console": return `${base}/results#search-console`
    default: return null
  }
}

/** A public page the agent's server fetched, cited as kind "web". Opened in a
 * new tab, never routed inside the app; only http(s) addresses qualify. */
export const webSourceUrl = (citation: AgentCitation): string | null => {
  if (citation.kind !== "web" || citation.id.length > 2000) return null
  try {
    const u = new URL(citation.id)
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null
  } catch {
    return null
  }
}
