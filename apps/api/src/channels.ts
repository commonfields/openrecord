import type { ChannelCapability, ChannelEntry, ChannelInventory, DiscoveredChannelKind, DiscoverySignals } from "@openrecord/contracts"

/** Facts gathered from the database and server configuration. */
export interface ChannelFacts {
  readonly businessId: string
  readonly websiteUrl: string | null
  readonly discovery: DiscoverySignals | null
  readonly siteTargets: number
  readonly ga4: {
    readonly configured: boolean
    readonly connections: ReadonlyArray<{ readonly status: "ACTIVE" | "REAUTHORIZATION_REQUIRED" | "DISCONNECTED"; readonly statusReason: string | null; readonly googleEmail: string }>
    readonly boundToBusiness: boolean
  }
  readonly github: { readonly configured: boolean; readonly targets: number }
  /** Providers the server declares. A declaration is not proof they work. */
  readonly answerProviders: ReadonlyArray<string>
  /** When a real (non-fixture) AI answer was last collected for this business. */
  readonly lastAnswerAt: string | null
}

const PROFILE_LABELS: Record<DiscoveredChannelKind, string> = {
  LINKEDIN: "LinkedIn", X: "X (Twitter)", FACEBOOK: "Facebook", INSTAGRAM: "Instagram", YOUTUBE: "YouTube", TIKTOK: "TikTok", PINTEREST: "Pinterest",
  GITHUB: "GitHub profile", GOOGLE_BUSINESS: "Google Business Profile", YELP: "Yelp", G2: "G2", CAPTERRA: "Capterra", PRODUCT_HUNT: "Product Hunt", EMAIL: "Email address",
}

/** What each integration actually implements. A ledger channel name (email,
 * social, paid) grants nothing here. */
const OFFERED = {
  website: ["DISCOVER", "PROPOSE", "VERIFY"],
  ga4: ["READ", "MEASURE"],
  github: ["EXECUTE", "VERIFY"],
  searchConsole: [],
} as const satisfies Record<string, ReadonlyArray<ChannelCapability>>

const host = (url: string | null) => {
  if (!url) return null
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
}

export const deriveChannelInventory = (f: ChannelFacts): ChannelInventory => {
  const base = `/businesses/${f.businessId}`
  const channels: ChannelEntry[] = []

  channels.push({
    key: "website", label: "Website", identity: host(f.websiteUrl), state: "DISCOVERED",
    active: [...(f.discovery ? ["DISCOVER" as const] : []), ...(f.siteTargets > 0 ? (["PROPOSE", "VERIFY"] as const) : [])],
    offered: [...OFFERED.website],
    note: f.siteTargets > 0
      ? "Read from the public web. Inspections find indexing problems, propose fixes and re-check the live page."
      : "Read from the public web. Inspect the site to find indexing problems and get proposed fixes.",
    action: { kind: "OPEN", label: f.siteTargets > 0 ? "Open website checks" : "Inspect website", href: `${base}/search` },
  })

  const ga4: ChannelEntry = (() => {
    const label = "Google Analytics 4"
    const measure = `/clients/${f.businessId}/growth-measurement`
    if (!f.ga4.configured)
      return { key: "ga4", label, identity: null, state: "UNSUPPORTED", active: [], offered: [...OFFERED.ga4],
        note: "Not configured on this server. Import daily numbers by hand instead.", action: null }
    const active = f.ga4.connections.find(c => c.status === "ACTIVE")
    if (active)
      return { key: "ga4", label, identity: active.googleEmail, state: "CONNECTED", active: f.ga4.boundToBusiness ? ["READ", "MEASURE"] : ["READ"], offered: [...OFFERED.ga4],
        note: f.ga4.boundToBusiness ? "Read-only. Daily key-event counts for this business are measured." : "Read-only access granted. Choose a property and key event to measure this business.",
        action: { kind: "OPEN", label: f.ga4.boundToBusiness ? "Open measurement" : "Choose property", href: measure } }
    const broken = f.ga4.connections.find(c => c.status === "REAUTHORIZATION_REQUIRED")
    if (broken)
      return { key: "ga4", label, identity: broken.googleEmail, state: broken.statusReason === "AUTHORIZATION_REVOKED" ? "REVOKED" : "UNHEALTHY", active: [], offered: [...OFFERED.ga4],
        note: broken.statusReason === "AUTHORIZATION_REVOKED" ? "Google access was revoked. Reconnect to resume measurement." : "The connection stopped working. Reconnect to resume measurement.",
        action: { kind: "CONNECT_GA4", label: "Reconnect", href: measure } }
    return { key: "ga4", label, identity: null, state: "PERMISSION_REQUIRED", active: [], offered: [...OFFERED.ga4],
      note: "Grant read-only access to measure your goal automatically. Optional: daily CSV imports work without it.",
      action: { kind: "CONNECT_GA4", label: "Connect", href: measure } }
  })()
  channels.push(ga4)

  channels.push(
    !f.github.configured
      ? { key: "github", label: "GitHub website changes", identity: null, state: "UNSUPPORTED", active: [], offered: [...OFFERED.github],
          note: "Not configured on this server. Website changes are made by you and recorded as attested work.", action: null }
      : f.github.targets > 0
        ? { key: "github", label: "GitHub website changes", identity: null, state: "CONNECTED", active: [...OFFERED.github], offered: [...OFFERED.github],
            note: "Configured by your administrator for this business's repository. One supported change: remove an accidental noindex tag through a pull request you merge. Access is checked each time a change runs; OpenRecord never merges.", action: null }
        : { key: "github", label: "GitHub website changes", identity: null, state: "PERMISSION_REQUIRED", active: [], offered: [...OFFERED.github],
            note: "Your administrator must allow this business's repository before OpenRecord can open pull requests.", action: null },
  )

  channels.push({ key: "search-console", label: "Google Search Console", identity: null, state: "UNSUPPORTED", active: [], offered: [...OFFERED.searchConsole],
    note: "Not available yet. Search traffic is not measured.", action: null })

  for (const c of f.discovery?.channels ?? [])
    channels.push({ key: `profile:${c.kind}`, label: PROFILE_LABELS[c.kind], identity: c.kind === "EMAIL" ? c.url.replace(/^mailto:/, "") : c.url, state: "DISCOVERED",
      active: ["DISCOVER"], offered: ["DISCOVER"],
      note: "Linked from your homepage. No integration: OpenRecord cannot read, post or measure here. Record work you do here by hand.", action: null })

  const day = (iso: string) => iso.slice(0, 10)
  return {
    channels,
    builtIn: [{
      key: "ai-answers",
      label: "AI answer checks",
      available: f.answerProviders.length > 0,
      note: f.answerProviders.length === 0
        ? "No AI provider is configured on this server, so answers cannot be checked yet."
        : f.lastAnswerAt
          ? `Asks AI assistants your buyers' questions and keeps their exact answers. Last answer collected ${day(f.lastAnswerAt)}. A mention is not a recommendation.`
          : `Configured on this server (${f.answerProviders.join(", ")}), but no answer has been collected for this business yet. The first check confirms it works.`,
      action: f.answerProviders.length > 0 ? { kind: "OPEN", label: "Run a check", href: `${base}/checks` } : null,
    }],
    manual: [
      { key: "attest", label: "Record work you did", note: "Log a change on any channel. It is marked as attested by you, not verified." },
      { key: "import", label: "Import daily numbers", note: "Upload a daily export for your goal metric." },
    ],
  }
}
