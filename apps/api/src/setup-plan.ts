import type { ChannelInventory, DiscoverySignals, GrowthOpportunityFields, SetupAssessment, SetupBrief, SetupStep } from "@openrecord/contracts"
import type { SetupRow } from "@openrecord/db"

/** The step follows from what is already recorded, so resuming is a re-read. */
export const setupStep = (row: Pick<SetupRow, "discoveryStatus" | "brief" | "channelsReviewedAt" | "opportunityId">): SetupStep =>
  row.discoveryStatus === "QUEUED" || row.discoveryStatus === "FETCHING" ? "DISCOVER"
    : !row.brief ? "CONFIRM"
      : !row.channelsReviewedAt ? "CONNECT"
        : !row.opportunityId ? "PROPOSE"
          : "DONE"

export const assessSetup = (signals: DiscoverySignals | null, failure: string | null, inventory: ChannelInventory, hasGoal: boolean): SetupAssessment => {
  const findings: Array<SetupAssessment["findings"][number]> = []
  if (!signals) {
    findings.push({ key: "homepage", tone: "unknown", text: `The homepage could not be read${failure ? ` (${failure.toLowerCase().replace(/_/g, " ")})` : ""}. Nothing about the site is assumed.` })
  } else {
    const c = signals.checks
    if (c.noindex) findings.push({ key: "noindex", tone: "gap", text: "The homepage tells search engines not to index it." })
    findings.push(c.hasOrganizationData
      ? { key: "org-data", tone: "ok", text: "The homepage describes the business in structured data search engines and AI assistants can read." }
      : { key: "org-data", tone: "gap", text: "No structured data on the homepage identifies the business (schema.org Organization), so search engines and AI assistants infer who you are from page text." })
    if (!c.hasTitle || !c.hasDescription)
      findings.push({ key: "snippet", tone: "gap", text: !c.hasTitle ? "The homepage has no title." : "The homepage has no description for search results." })
    const profiles = signals.channels.filter(ch => ch.kind !== "EMAIL").length
    findings.push(profiles > 0
      ? { key: "profiles", tone: "ok", text: `${profiles} public ${profiles === 1 ? "profile is" : "profiles are"} linked from the homepage.` }
      : { key: "profiles", tone: "unknown", text: "No public profiles are linked from the homepage." })
  }
  const answers = inventory.builtIn.find(b => b.key === "ai-answers")
  findings.push(answers?.available
    ? { key: "answers", tone: "unknown", text: "What AI assistants say about you has not been checked yet." }
    : { key: "answers", tone: "unknown", text: "AI answers cannot be checked on this server yet." })
  const ga4 = inventory.channels.find(ch => ch.key === "ga4")
  const measured = ga4?.state === "CONNECTED" && ga4.active.includes("MEASURE")
  findings.push(measured
    ? { key: "measurement", tone: "ok", text: "Your goal is measured from Google Analytics." }
    : hasGoal
      ? { key: "measurement", tone: "unknown", text: "Your goal has no data yet. Results stay unknown until numbers are imported or analytics is connected." }
      : { key: "measurement", tone: "gap", text: "No goal is set, so results cannot be measured." })
  return { findings, measurement: measured ? "CONNECTED" : hasGoal ? "MANUAL_ONLY" : "NONE" }
}

export type WebsiteCheckKey = "homepage.noindex" | "homepage.organization-data" | "homepage.snippet"
type Rule = { readonly key: WebsiteCheckKey; readonly when: (s: DiscoverySignals) => boolean; readonly build: (ctx: RuleCtx) => Omit<GrowthOpportunityFields, "goalId" | "audience" | "targetUrl" | "source" | "baselineAvailability"> }
type RuleCtx = { readonly brief: SetupBrief; readonly site: string }

/** Ordered from most to least urgent; the first match becomes the first
 * initiative. Each one is bounded to the homepage the operator gave. The
 * agent's first-improvement workflow diagnoses with the same rules. */
export const WEBSITE_RULES: ReadonlyArray<Rule> = [
  { key: "homepage.noindex", when: s => s.checks.noindex, build: ({ brief }) => ({
    title: "Let search engines index the homepage",
    problemStatement: "The homepage carries a noindex instruction, so search engines are told to leave it out of results.",
    buyerIntent: `Find ${brief.businessName} when searching for ${brief.category.toLowerCase()}`,
    proposedChange: "Remove the noindex robots instruction from the homepage, unless hiding it is intended.",
    expectedMechanism: "An indexable homepage can appear in search results and be read by AI assistants that rely on search.",
    assumptions: "The noindex instruction is accidental.",
    uncertainty: `No baseline is measured. Any effect on ${brief.metricLabel.toLowerCase()} is unknown until it is measured.`,
  }) },
  { key: "homepage.organization-data", when: s => !s.checks.hasOrganizationData, build: ({ brief, site }) => ({
    title: "Identify the business in structured data on the homepage",
    problemStatement: `No structured data on ${site} identifies the business (schema.org Organization), so search engines and AI assistants infer the name, offer and contact details from page text.`,
    buyerIntent: `Get an accurate answer about ${brief.businessName} from a search engine or AI assistant`,
    proposedChange: "Add schema.org Organization data to the homepage with the confirmed name, website, contact details and public profiles.",
    expectedMechanism: "Machine-readable identity reduces guessing, which can make descriptions of the business in search and AI answers more accurate.",
    assumptions: "The confirmed brief is accurate and the site can be edited.",
    uncertainty: `Search engines and AI assistants decide independently whether to use structured data. Any effect on ${brief.metricLabel.toLowerCase()} is unmeasured.`,
  }) },
  { key: "homepage.snippet", when: s => !s.checks.hasTitle || !s.checks.hasDescription, build: ({ brief }) => ({
    title: "Write a clear homepage title and description",
    problemStatement: "The homepage is missing a title or description, so search results show whatever text search engines pick.",
    buyerIntent: `Understand what ${brief.businessName} offers from a search result`,
    proposedChange: `Write a title and meta description that state the offer: ${brief.valueProposition.slice(0, 200)}`,
    expectedMechanism: "A clear result snippet helps the right buyers recognise the offer before they click.",
    assumptions: "Buyers find the business through search.",
    uncertainty: `Search engines may rewrite snippets. Any effect on ${brief.metricLabel.toLowerCase()} is unmeasured.`,
  }) },
]
const FALLBACK: Rule["build"] = ({ brief }) => ({
  title: "Answer the questions buyers ask AI assistants",
  problemStatement: `It is not yet known what AI assistants say when buyers ask about ${brief.category.toLowerCase()}.`,
  buyerIntent: `Choose a ${brief.category.toLowerCase()} provider`,
  proposedChange: "Publish a page that answers the three questions buyers ask most, using only confirmed facts, then check what AI assistants say.",
  expectedMechanism: "Clear public answers give search engines and AI assistants accurate material to quote.",
  assumptions: "Buyers ask AI assistants before choosing.",
  uncertainty: `AI assistants may not use the page. Any effect on ${brief.metricLabel.toLowerCase()} is unmeasured.`,
})

export const firstInitiative = (input: { readonly goalId: string; readonly brief: SetupBrief; readonly websiteUrl: string; readonly signals: DiscoverySignals | null; readonly readOn: string }): GrowthOpportunityFields => {
  const site = new URL(input.websiteUrl).hostname.replace(/^www\./, "")
  const rule = input.signals ? WEBSITE_RULES.find(r => r.when(input.signals!)) : undefined
  const fields = (rule?.build ?? FALLBACK)({ brief: input.brief, site })
  return {
    ...fields,
    goalId: input.goalId,
    audience: input.brief.audience,
    targetUrl: input.websiteUrl,
    source: input.signals ? `OpenRecord setup: public homepage read on ${input.readOn}` : "OpenRecord setup: operator brief (homepage unreadable)",
    baselineAvailability: "UNKNOWN",
  }
}
