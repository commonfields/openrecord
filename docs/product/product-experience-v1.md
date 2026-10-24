# Product Experience V1 — UX audit

Scope: the real routes and components on `main` at `a498f515` (web app: `apps/web/app`).
Method: full read of navigation, routes and growth components; acceptance walkthroughs
against a locally seeded backend. This audit drove the implementation on
`feat/product-experience-v1`; findings are phrased as operator-visible problems.

## What the product already has

Two parallel surfaces, both functional and deliberately kept:

1. **Agency surface** (`/clients`, `/clients/:id`, `/clients/:id/growth`,
   `/clients/:id/growth-measurement`, `/clients/:id/discovery`) — client records,
   Record Integrity (three approved facts, live AI checks, human judgment, public
   record), AI Discovery, and the Growth workflow (goal → opportunities → plan →
   execution → measurement → evaluation → client report).
2. **Business evidence workspace** (`/businesses/:id/…`) — overview, prospect assay,
   search, issues, representations, truth, checks.

The Growth workflow (W0–W8) is technically complete: versioned goals and metric
definitions, operator/agent opportunity intake with human approval, measurement
plans, the execution ledger with assurance levels, daily imports (CSV and GA4),
outcome evaluation with reasons/caveats, and immutable client reports.

## Highest-impact problems

### P1 — The clients list is not an operations entry point (navigation)
`clients.tsx` renders name, domain, "last checked" and share-link state only.
Nothing tells the operator which clients have a marketing goal or an active
initiative, and the row links only to the Record Integrity page. The Growth
workspace — the actual marketing workflow — is one unlabeled hop away and absent
from the list entirely. The page also titles itself "Products and clients" while
the sidebar says "Clients", and its empty state teaches only the record loop.

### P2 — The growth pipeline is invisible (hierarchy)
`client-growth.tsx` renders each opportunity as a dense card: a flat `dl` grid of
nine technical fields, then four collapsed `<details>` sections (Measurement plan,
Connected change, Outcome evaluation, Client report) that all look equally weighted.
The workflow the backend actually enforces — Goal → Plan → Execute → Measure →
Report — exists nowhere on screen. An operator cannot see where an initiative
stands, what is verified, or what the next action is without expanding every
section. Stage state, completed steps, blocking conditions and next actions are
all present in the read models but not organized by stage.

### P3 — Opportunity creation front-loads technical detail (progressive disclosure)
The "Propose an opportunity" form shows nine required fields at once, mixing the
operator's story (title, problem, change) with research metadata (mechanism,
assumptions, uncertainty, source). All fields are genuinely required by the API;
the problem is sequencing, not validation. First-time operators get a wall of
inputs before understanding what an initiative is.

### P4 — First-use guidance is missing (guided first-use)
- A new account's `/clients` shows a panel about the record loop only; the goal →
  initiative → measurement path is unmentioned.
- A client without a growth profile lands on an empty opportunities list with
  "Investigate existing evidence with the Operator Agent, or write a specific
  hypothesis" — but the actual first step is defining the goal and metric.
- Nothing on the growth page says that GitHub/GA4 connections are optional, nor
  that manual CSV exports are a first-class measurement path. The GA4 panel says
  "not configured" in a way that reads like an error.

### P5 — Loading/empty states and status legibility (consistency)
- `ClientGrowthPage` and `ClientGrowthMeasurementPage` render a bare text line
  ("Loading growth workspace…") where every other page uses skeletons.
- Approval/execution assurance states (operator-attested vs system-verified,
  proposed vs approved vs reviewed) are conveyed through small badges with long
  prose inside collapsed sections; the page headline never answers "is anything
  approved/verified yet?".
- Page titles are `text-sm`, the same size as section headings, so hierarchy
  within a page relies on color alone.

### P6 — Cross-navigation between the two surfaces is weak (coexistence)
The growth page links to Record Integrity, AI Discovery and the business overview
as small text links in the header meta; the reverse direction (client record →
growth) has no equivalent affordance. The older surfaces are otherwise fine and
must be preserved; the gap is wayfinding, not function.

## Constraints respected in the implementation

- No backend, contract, worker, provider or OAuth changes; existing read models and
  endpoints only (opportunities, measurement plan, imports, evaluation, reports).
- `growth-ga4.tsx` and `growth-execution.tsx` internals untouched; only placement,
  labels and surroundings change.
- Record Integrity and AI Discovery flows preserved; no merging of surfaces.
- Existing UI components and design tokens reused; no new framework.
- UX-correctness invariants (proposed ≠ approved, attested ≠ verified, merge ≠
  publication, availability ≠ improvement, indeterminate is valid, published
  reports immutable) are kept and made more legible, never weakened.
