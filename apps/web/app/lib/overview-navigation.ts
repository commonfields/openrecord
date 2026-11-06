export const OVERVIEW_SECTIONS = [
  { key: "summary", label: "Summary", description: "Your goal, work in progress, and decisions that need you." },
  { key: "performance", label: "Performance", description: "Search, advertising and local listing results from connected accounts." },
  { key: "revenue", label: "Revenue", description: "Revenue and paying customers reported by Stripe." },
  { key: "funnel", label: "Funnel", description: "What you can measure across the customer journey, and what is still missing." },
  { key: "events", label: "Events", description: "Your saved goal event and its daily measurement history." },
  { key: "realtime", label: "Realtime", description: "Live measurement availability for this business." },
  { key: "answers", label: "AI discovery", description: "What AI answers say about you, buyer questions and referral evidence." },
] as const

export const overviewSection = (key?: string) => OVERVIEW_SECTIONS.find(section => section.key === key) ?? OVERVIEW_SECTIONS[0]
export const overviewPath = (businessId: string, section: string) => `/businesses/${businessId}/results${section === "summary" ? "" : `/${section}`}`
