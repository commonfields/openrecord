// Workspace navigation: single source of truth for sidebar order, labels,
// routes, and breadcrumbs. Tested in tests/product-surface.test.ts.
export interface WorkspaceNavItem {
  readonly id: "overview" | "assay" | "search" | "issues" | "representations" | "truth" | "checks"
  readonly label: string
  readonly path: string
  readonly icon: "overview" | "assay" | "search" | "issues" | "representations" | "truth" | "checks"
}

// Operational workflow comes before the measurement instrument.
export const workspaceNavOrder: ReadonlyArray<WorkspaceNavItem["id"]> = ["overview", "assay", "search", "issues", "representations", "truth", "checks"]

export const workspaceNav = (base: string): WorkspaceNavItem[] => [
  { id: "overview", label: "Overview", path: `${base}/overview`, icon: "overview" },
  { id: "assay", label: "Prospect assay", path: `${base}/assay`, icon: "assay" },
  { id: "search", label: "Search", path: `${base}/search`, icon: "search" },
  { id: "issues", label: "Issues", path: `${base}/issues`, icon: "issues" },
  { id: "representations", label: "Representations", path: `${base}/representations`, icon: "representations" },
  { id: "truth", label: "Truth", path: `${base}/truth`, icon: "truth" },
  { id: "checks", label: "Checks", path: `${base}/checks`, icon: "checks" },
]

// Breadcrumb names. The four workspace areas come first; the specialist
// evidence tools keep their routes but read in plain language.
export const sectionTitles: Record<string, string> = {
  agent: "Agent",
  channels: "Channels",
  work: "Work",
  results: "Results",
  overview: "Agent",
  assay: "Prospect research",
  search: "Website checks",
  issues: "AI answer issues",
  representations: "Facts on the web",
  truth: "Approved facts",
  checks: "AI answer checks",
  facts: "Approved facts",
}

export type RepresentationFilter = "ALL" | "IN_SYNC" | "DRIFT" | "UNKNOWN"

export const representationFilters: ReadonlyArray<RepresentationFilter> = ["ALL", "DRIFT", "UNKNOWN", "IN_SYNC"]

export const representationFilterLabels: Record<RepresentationFilter, string> = {
  ALL: "All",
  DRIFT: "Drift",
  UNKNOWN: "Unknown",
  IN_SYNC: "In sync",
}
