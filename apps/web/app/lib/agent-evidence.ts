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
    case "record": return `/clients/${businessId}`
    default: return null
  }
}
