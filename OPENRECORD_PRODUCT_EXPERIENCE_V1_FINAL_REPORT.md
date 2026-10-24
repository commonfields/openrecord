# OPENRECORD_PRODUCT_EXPERIENCE_V1 — Final Report

Branch: `feat/product-experience-v1`
Starting SHA: `5ebaa815` (last verified main) — rebased onto `a498f515` (PR #74, GA4 zero-day semantics) before implementation; no overlapping files with that PR or the live-validation agent.
Audit: `docs/product/product-experience-v1.md`. Screenshots: `docs/product/screenshots/product-experience-v1/` (19 genuine rendered captures; see limitations).

## 1. UX problems identified (audit summary)

1. **The clients list was not an operations entry point** — no marketing progress, no path into Growth; the empty state taught only the Record Integrity loop.
2. **The growth pipeline was invisible** — each opportunity rendered nine technical fields plus four equally weighted collapsed sections; Goal → Plan → Execute → Measure → Report existed only in backend semantics.
3. **Opportunity creation front-loaded technical detail** — nine required fields in one wall, story and research evidence mixed.
4. **First-use guidance was missing** — nothing distinguished "no goal yet" from "no initiatives yet", and GitHub/GA4 connections read as required.
5. **Loading/status legibility** — bare text loading lines on Growth pages; approval/assurance state buried in collapsed prose.
6. **Weak cross-navigation** between the agency surface (`/clients`) and the evidence workspace (`/businesses`), and a wrong breadcrumb for measurement imports.

## 2. Changes implemented (frontend only)

- `apps/web/app/lib/growth-stage.ts` (new): pure stage model. Each stage's state derives **only from persisted evidence** — declared plan (`timing`), execution ledger with `assurance`, import count for the metric, published report versions and status. Unapproved initiatives show Goal + the pending human decision instead of four "available after approval" chips. Post-hoc plans stay flagged (`Declared after the work was recorded`). A merged PR reads as "System-verified merge confirmed — not live publication".
- `apps/web/app/components/growth-pipeline.tsx` (new): the visible workflow — a five-chip stage strip (state, detail, next action, caveat) plus numbered stage sections that wrap the **unchanged** lazy sections (`GrowthPlanSection`, `GrowthExecutionSection`, `GrowthEvaluationSection`, `GrowthReportPanel`) in workflow order. `Record execution` lives in the Execute stage; "Connected change" is explicitly labeled optional.
- `apps/web/app/routes/client-growth.tsx`: pipeline-driven initiative cards with a promoted "Planned change" line; technical metadata, evidence, event and execution history moved into one labeled "All details, evidence and history" disclosure; **two-step guided opportunity form** (identical fields, validation and API payload — sequencing only); guided "Start with one goal" panel when no profile exists; skeleton loading states.
- `apps/web/app/routes/clients.tsx`: growth-first client list — marketing-progress column (goal statement, initiative counts, verified-execution counts), rows open the Growth workspace, Record/AI Discovery one click away, honest stat strip (Clients / With a marketing goal / Approved initiatives / Shared), rewritten empty state and `useClientGrowth` parallel reads mirroring the existing businesses-list pattern.
- `apps/web/app/routes/client-growth-measurement.tsx`: skeletons, a "No metric to measure yet" state that links back to the goal editor, manual-CSV-first copy (connections optional).
- `apps/web/app/lib/growth.ts`: `importsCount` helper over the existing imports endpoint (null on failure → the strip claims nothing).
- `apps/web/app/components/growth-measurement.tsx`: import-refusal copy now distinguishes GA4-export files from operator `date,value` files (acceptance finding — the old message misdirected GA4-metric operators).
- `apps/web/app/components/app-shell.tsx`: breadcrumb labels for growth-measurement/AI Discovery; "Clients" naming consistency.
- `apps/web/app/components/page.tsx`: page titles promoted (`text-base font-semibold`) for hierarchy.
- `apps/web/app/routes/product-new.tsx`: back-link label consistency.

Untouched by design: backend/API/contracts, `growth-ga4.tsx` and `growth-execution.tsx` internals, `growth-plan/evaluation/report` components, Record Integrity and AI Discovery flows.

## 3. Before → after workflow

Before: `/clients` → client record (facts/checks) → guess that Growth exists → one dense page where stage order, proof level and next action required expanding every section.

After: `/clients` shows each client's marketing state at a glance → one click into the Growth workspace → the goal panel, then each initiative as a stage strip answering, per stage: **current state, what is done, proof level, next action, blockers** → stage sections in workflow order with the existing evidence-preserving components → publish/share from the Report stage.

## 4. Acceptance journeys (real input events; screenshots)

All ten journeys were driven through the real frontend with CDP-dispatched pointer/keyboard events (`Input.dispatchMouseEvent`/`Input.insertText` — genuine browser input, the same mechanism Playwright uses), against a locally seeded backend on my worktree's stack:

1. **First-time operator** — sign-in, empty `/clients` with the new guided empty state (`j1-*`).
2. **Create business with goal** — client dialog → record → guided growth first-use → goal saved (`j2-*`, `j3-*`).
3. **Create + approve initiative** — two-step proposal, "Waiting for a human decision", approve → pipeline (`j4-*`, `j5-approved-pipeline`).
4. **Measurement plan** — four dates declared; strip shows "Declared before the work · 2026-09-01 → 2026-09-28" (`j6-plan-declared`).
5. **Operator-attested execution** — dialog; strip shows "1 recorded action · Operator-attested — not independently verified" (`j7-execution-recorded`).
6. **Measurement imports** — GA4-shaped manual export, "Imported: … 28/28 days reported"; duplicate submission replays idempotently ("Replayed import — same bytes, unchanged record") (`j8-measurement-imported`, `i1-*`).
7. **Connected-provider states without credentials** — GA4 panel renders its "not configured" state without blocking manual exports; GitHub never required (visible in Execute stage copy).
8. **Indeterminate evaluation** — "Indeterminate" with "Why no comparison is shown" reasons (`i2-evaluation-indeterminate`); also exercised a second blocker (`EXECUTION_TIMING_INCOMPATIBLE`) on another client. A **comparable** reading is structurally unreachable in a single live session by design (declaration ≤ action ≤ observationStart ≤ observationEnd < today); it is covered by component fixtures and documented here rather than fabricated.
9. **Human decision** — review recorded (KEEP) with the limit acknowledged; status "Reviewed" (`i3-decision-recorded`, `j10-decision-recorded`).
10. **Report preview/publish/access** — preview ("Draft preview, not yet published"), publish (immutable version), share link, public report read without a session (`i4/i5-*`, `j11-*`, `j12-public-report`).

Error/empty/blocked states exercised: refused import with readable reason (`err-import-refused`), replay-idempotent import, indeterminate reasons, "No metric to measure yet", client-not-found error state, blocked Report stage ("A report lists recorded actions; record the work first").

**Acceptance defects found and fixed during the run**
- Two-step form's "Next" button submitted the final payload early (real UI bug) — fixed so submit advances on step 1 and creates only on step 2.
- Wrong import-refusal copy for GA4-sourced metrics — now names the GA4 export shape.
- Breadcrumb for `/growth-measurement` said "Client record" — fixed.
- Noted (not changed): minute-precision attestation default can land just before a plan declared seconds earlier; the backend truthfully flags `PLAN_DECLARED_AFTER_EXECUTION` and the strip surfaces it. Operators can edit the performed time; left as-is because attestation semantics are backend-owned.

## 5. Accessibility and responsive results

- 375px: zero horizontal overflow on clients list, growth workspace, measurement page and public report; the stage strip stacks vertically and remains fully legible (`375x812-m-*`).
- Hierarchy: page titles promoted; stage states carry screen-reader words (`complete` / `current stage` / `not started` / `needs attention`) alongside the visual chips; stage sections and details are native `<details>/<summary>` (keyboard-operable); buttons/inputs reuse the existing focus-visible ring components; dialogs are Radix (focus-trapped, labelled).
- The interactive harness session was unstable (tabs repeatedly closed), so a dedicated **keyboard-only pass through every dialog was not completed**; native elements and Radix primitives carry the keyboard behavior, and pointer-driven acceptance is complete. This is recorded as a limitation, not claimed coverage.

## 6. Engineering gates

| Gate | Result |
| --- | --- |
| Typecheck (`@openrecord/web`) | 0 errors |
| Lint (`eslint app tests --max-warnings 0`) | clean |
| Web tests | 16 files, **123/123 pass** (111 pre-existing preserved + 12 new stage-model tests) |
| Production build (`vite build`) | succeeds |
| API contract tests | none touched; `apps/api` unmodified on this branch |
| Browser acceptance | complete (above) |

W0–W8 behavior, API contracts and the validation agent's W7/W8 work are untouched.

## 7. Visual-verification method and limitations

- The interactive harness's `screenshot` tool was blocked ("needs a visible tab"; window not visible) and both `osascript` automation and `safaridriver --enable` were unauthorized on this machine. Capture fallback: headless Chromium (Helium 155) driven over the DevTools protocol with the real session cookie, `deviceScaleFactor` 2 — every screenshot is a genuine rendered page, not a mockup. Files in `docs/product/screenshots/product-experience-v1/`.
- Driver-side issues (GA4 CSV shape, a UTC/local datetime mix, headless HTTP cache) were diagnosed and fixed during the run; none were app defects except those listed in §4.
- "Claiming" boundary: the comparable-evaluation screenshots in the repo come from component fixtures (test evidence), not from a fabricated live session.

## 8. Known remaining UX problems

1. A truly comparable before/after reading requires the initiative to age (declare → act → wait for the observation window → import). The UI communicates this only through the indeterminate reasons; a dedicated "this window completes on …" hint in the Measure stage would help (needs no backend change; left for a follow-up to keep this diff focused).
2. Minute-precision performed-time default can precede a plan declared seconds earlier (see §4 note).
3. Full keyboard-only traversal of every dialog was not separately exercised (§5).
4. The client list loads one profile + one opportunities read per client in parallel (same pattern as the businesses list); agencies with very large portfolios may need a consolidated read model (backend work, out of scope).

## 9. PR and merge status

- PR #76 (`feat/product-experience-v1`) — **merged** into `main` as `d7383c2` after all CI checks passed (CLI + hosted matrices, both green).
- Rebased onto `fd3972f` (PR #75, hosted-pilot) before the merge; zero file overlap with the concurrent agents' work at rebase time and at merge time.
- This file's status section was finalized post-merge; no production deployment was performed.
