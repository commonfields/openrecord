# OpenRecord agent context

Working synthesis for the agent roadmap. Written 2026-11-09 against `main` at
`67f4b2a4ae83`. That is one merge after the requested baseline `582f2d42410f`:
PR #137, a web-only theme fix, which the operator accepted as the baseline.
Uncommitted M1 to M4 work from a 2026-11-08 session is parked unreviewed on the
local branch `wip/agent-m1-m4-20261108`. It is reference material, not a
starting point. The external audit is in `docs/external-repo-audit.md`.

## Governing principle

The agent owns progress. The application owns state and authority. Evidence
determines what can be claimed. Marketing judgment determines what to do next.

Three properties are measured, never assumed:

1. **Marketing intelligence**: the right problem and a defensible intervention.
2. **Execution competence**: safe, authorized, recoverable work.
3. **Outcome intelligence**: observed results improve the next decisions.

**Moat: none validated.** The candidate is a permissioned history of beliefs,
decisions, authorized work, verified delivery, outcomes and lessons that
measurably improves later decisions. Each link of that chain must be a
structured relation the application writes. Prose the model may or may not
produce does not count.

## Roadmap (only M1 is authorized to build)

| Milestone | Claim it would make true | Status |
| --- | --- | --- |
| M1 Objective lineage integrity | Work created under the active objective can be recovered from the objective through a structured query, whatever the model wrote | Implemented locally (migration 0082, `objective-work.ts`). Not committed or pushed. |
| M1.5 Capability registry | Each step loads only relevant, permitted, evaluated capabilities | Designed below. Not to be built before M1 is accepted. |
| M2 Deliverable and outcome binding | Approved revision, then verified delivery, then a predeclared measurement, then an observed outcome | Not started on `main` |
| M3 Persistent controlled work | Resume and cancel with no duplicate external effects | Partly present (`agent-request-queue.ts` fencing). Not started as a milestone. |
| M4 Commercial and learning validation | Real operators get value that repeats | Not started. Needs real operators. |

## Current system, as read from code

- **Stack.** An Effect API (`apps/api`), Vite web (`apps/web`), workers, and
  Postgres with numbered SQL migrations (`packages/db/migrations`, latest
  `0081`). Tenancy is `account_id` to `business_id`. Every scoped read goes
  through `BusinessRepository.getScoped(accountId, businessId)`, and most
  tables carry composite `(business_id, id)` foreign keys, so cross-tenant
  references fail in the database.
- **Agent loop.** The server-owned tool loop is `runConversation` in
  `apps/api/src/agent.ts`. Tools are `AGENT_TOOL_SPECS` in `agent-registry.ts`,
  with `effect` (read 49, record 14, propose 10) and `replay` (`safe` or
  `deduplicated`). The model never holds credentials, and external effects
  happen only on operator approval routes.
- **Objective.** A human-authored, versioned `growth_goals` row. The business's
  active objective is `growth_profiles.primary_goal_id`, one per business,
  enforced by the primary key. A goal edit inserts a new version and repoints
  the profile (`packages/db/src/growth.ts:159-168`). Investigations
  (`growth_investigations`) are agent questions under a goal. Notes
  (`growth_investigation_notes`) are append-only and immutable by trigger
  (0052).
- **Work artifacts and their current link to the objective:**

| Artifact | Created in | Link to objective today |
| --- | --- | --- |
| Growth opportunity | `packages/db/src/growth.ts:268` | **Structural**: `growth_opportunities.goal_id NOT NULL` |
| Campaign and revision 1 | Agent: `campaign-agent.ts` `draftMarketingCampaign` (one transaction). Operator: `campaigns.ts` POST, `revision === 0` (one transaction). | **None.** Only an optional note (`record_investigation_note` with `campaignId`, migration 0081). |
| Deliverables | Inside `marketing_campaigns.brief.tasks`, the same insert. `record_campaign_revision` `addDeliverables` adds more. | Inherit from the campaign. There is no separate row. |
| Campaign run | `campaign-engine.ts:95` | Inherits through its `(business_id, campaign_id)` foreign key |
| WordPress change (execution artifact) | `wordpress.ts:149` `prepareChange`, a single insert | **None.** It joins a campaign only through `marketing_campaign_deliveries`. |
| Account action (execution artifact) | `account-actions.ts:177` | **None.** It has no campaign link either (`marketing-operating-policy.ts` says so). |

- **The P0 gap, in the repo's own words.** "Linking depends on the model
  following the policy. The server does not require a note after saved
  campaign work, and no live-model eval checks it"
  (`docs/architecture/objective-campaign-continuity.md`, Limitations). The
  resume brief (`agent-resume.ts`) finds campaigns only through notes
  (`objectives.ts` `linkedCampaigns`). A campaign saved without a note is
  invisible to a fresh conversation's objective view.
- **Tool loading today.** I measured this by running the registry under
  `tsx` (script kept outside the repo):

| Turn type | Tools declared | Schema bytes |
| --- | --- | --- |
| Ordinary conversation | 71 | 78,920 (the request cap is 128,000, `EXECUTION_LIMITS`) |
| `/marketing` | 34 | 43,539 |
| `/campaign` | 20 | 24,105 |
| `/campaign-run` | 21 | 25,638 |
| `/status` | 9 | 5,576 |

  On top of that, the system prompt in `agent.ts` is about 50 KB of source. It
  includes a long prose inventory of research sources. 2,204 research
  capabilities already sit behind a two-tool `find_research_capabilities` and
  `run_research` pair, ranked by keywords (`research/catalog.ts`
  `findCapabilities`). That pair is the seed of M1.5.
- **Evals.** `apps/api/src/evals` grade answer prose against fixed evidence.
  Nothing yet grades persisted state or tool selection.

## M1: objective lineage integrity (approved 2026-11-09, implemented locally)

### Definition

The active objective at creation time is
`growth_profiles.primary_goal_id` for the business. It is read by a
subquery inside the very `INSERT` that creates the row, so the link and the
row are one statement. A concurrent goal change commits either before or
after that statement, and the link records whichever goal was primary then.
The application knows it, not the model.

- **No growth profile:** the objective is unknown. Link nothing.
- **Never** take an objective from model arguments, notes or conversation
  text.
- An investigation-level link stays optional and note-based. Choosing which
  investigation work belongs to is a judgment, so it would be a guess.

### Steps

1. **Reproduce first.** Add an integration test. It creates a campaign through
   `record_campaign_draft` with no investigation note. A fresh conversation's
   `readObjectiveInvestigations` or `loadResumeContext`, and a direct
   structured query by goal, must return that campaign. Expected result
   today: the test fails, because no column or relation exists.
2. **Schema. Existing fields were checked and found insufficient.**
   - `marketing_campaigns`, `wordpress_changes` and `account_actions` have no
     goal reference.
   - Reusing `growth_opportunities.goal_id` would need a campaign-to-opportunity
     link that does not exist.
   - An automatic system-authored note would have to pick an investigation,
     which is a guess, and would make a note the source of truth.

   Proposed, additive and non-destructive: a nullable `objective_goal_id` on
   those three tables. It has a composite foreign key
   `(objective_goal_id, business_id)` to `growth_goals(id, business_id)`, a
   partial index, and a `BEFORE UPDATE` trigger that refuses changes to it.
   There is no backfill: legacy rows stay null. **This is new schema and is
   flagged for approval.**
3. **Write path.** Same transaction, same statement:
   - Agent draft: `campaign-agent.ts`. The transaction already locks the
     business row.
   - Operator create: `campaigns.ts`, `revision === 0`.
   - `prepareChange` in `wordpress.ts`. It is a single atomic insert; the goal
     is selected in the same `INSERT ... SELECT`.
   - The account-action insert.

   Deliverables and runs inherit from their campaign. Replays return the
   original row, and the trigger keeps its lineage.
4. **Recovery.** A structured read: objective, then campaigns (with
   deliverable counts and latest run), WordPress changes and account actions,
   by `business_id` and `objective_goal_id`. Exposed in
   `readObjectiveInvestigations` and the resume brief. No note parsing, no
   model recall.
5. **Notes.** Unchanged: append-only explanatory context, never overwritten,
   never the source of lineage.

### Decisions needed from the operator before Phase 1

- **A. Active objective:** is "the business's primary goal at creation time"
  acceptable? The alternative is an objective pinned to the conversation. That
  is more precise, but needs a new conversation column and changes
  conversation semantics.
- **B. Goal versions:** a goal edit creates a new goal id. Should recovery
  return work linked to the current version only, or to every version of the
  business's goal history, labelled by version? Proposed: the current version
  first, earlier versions listed and labelled.
- **C. Mismatch at delivery:** a WordPress change prepared under goal v2 might
  be linked by `record_campaign_delivery` to a campaign created under v1.
  Proposed: report the mismatch in recovery and never refuse. Refusing would
  change delivery semantics, which is out of M1 scope.
- **D. `agent_proposals`:** the parked branch also tagged them. They are
  re-check proposals, not campaign work, so I propose excluding them from M1.

### Required tests (planned)

- **Unit:** each creation path sets `objective_goal_id` from the profile and
  never from input.
- **Integration:** create under an objective with no note. A fresh
  conversation recovers exactly the linked campaign, WordPress change and
  account action.
- **Regression:** existing notes and their 0081 links are byte-identical; old
  rows stay null.
- **Negative:**
  - No profile means a null link.
  - Another business's goal fails at the foreign key, which is also tried
    with a raw insert.
  - An unauthorized account is refused before any write.
  - An `UPDATE` of `objective_goal_id` is refused.
  - Revisions, approvals and decisions are unchanged.

### What stays model-dependent after M1

- Which investigation a piece of work advances.
- Whether the agent reads the recovered work before acting.
- Whether summaries misstate run state.

Stop conditions remain as the brief states: a passing reproduction, a
destructive migration, a change to ownership or authorization, or a new
dependency.

## M1.5 design: capability registry (design only)

### Problem

Every ordinary turn sends 71 schemas (about 79 KB) plus a long prose source
list. Scoping is a hand-maintained regex allowlist (`commandTools`).
Selection, cost and latency degrade as capabilities grow. *Lost in the Middle*
predicts worse use of mid-context material; that is a hypothesis to measure
here, not a fact for this codebase.

### Target

- Any number of capabilities in a registry.
- Each model step sees a small core set plus the top-k (5 to 15) relevant,
  **permitted** and **evaluated** schemas.
- Selection is recorded, and authority is still checked at execution.

### Manifest (one per capability version, in code and reviewed in PRs)

```ts
interface CapabilityManifest {
  id: string                          // "campaign.record_draft", namespaced
  version: number                     // a bump on any schema or semantic change
  namespace: "research" | "strategy" | "creative" | "media" | "crm" | "measurement" | "web" | "work"
  title: string
  when_to_use: string                 // the model-facing purpose, one paragraph
  when_not_to_use: string             // near-misses and the capability to use instead
  input_schema: JSONSchema            // generated from an Effect Schema
  output_schema: JSONSchema
  side_effect: "none" | "internal_write" | "external_write" | "irreversible"
  permission: { role: "member" | "operator"; requires_approval: boolean; scopes: string[] }
  idempotency: { kind: "safe_read" | "request_key"; key_fields: string[] } // Stripe semantics
  cost_class: "free" | "metered" | "paid"; latency_class: "fast" | "slow" | "background"
  tenant_scope: "business" | "account" | "public"
  availability?: (ctx) => Effect<string | null> // a reason it cannot run here, or null (exists in research/types.ts)
  evidence_produced: Array<"observation" | "proposal" | "receipt" | "draft" | "none">
  eval_cases: EvalCase[]              // empty means disabled by default
  deprecated_by?: string
}
interface EvalCase {
  id: string; task: string            // a natural-language step
  fixture: string                     // database or fixture-adapter seed
  expect_selected: boolean            // routing: must or must not be in the top-k
  expect_state?: string               // grader over persisted rows and adapter calls, not prose
}
```

How it maps onto what exists:

| Manifest field | Today's equivalent |
| --- | --- |
| `side_effect: none` | `effect: read` |
| `side_effect: internal_write` | `record` and `propose`. A proposal is an internal row. |
| `external_write`, `irreversible` | Only the operator approval routes and adapters do this today. **The agent loop stays unable to call them directly.** |
| `idempotency` | `replay` |
| MCP `readOnlyHint`, `destructiveHint`, `idempotentHint` | Derived for `mcp-server.ts` export. They are hints only. |

### Routing (per step, deterministic)

1. **Hard filter, cheap and fail-closed:**
   - enabled, meaning it has at least one eval case;
   - `availability` is null for this business;
   - permission is held by the caller;
   - `side_effect` is allowed for the turn type;
   - tenant scope matches.

   Deny by default.
2. **Rank:** keyword ranking reusing `findCapabilities`, run over the step's
   user message and the latest tool results. Stable tie-break by id and
   version. Embedding ranking is added only if it beats keyword recall on the
   routing evals; it brings no new dependency in the first cut.
3. **Assemble:**
   - Core set, always loaded, about 6: `read_business_truth`,
     `read_objective_investigations`, `read_objective_work` (M1),
     `read_proposals`, `find_capabilities`, `load_capability`.
   - Plus the top k of 10 or fewer.
   - `load_capability(id)` lets the model pull a schema it found, through the
     same filter.
4. **Trace:** each step records `{router_version, candidates, selected, k}`,
   and every call records `{capability id, version, side_effect, decision}`
   in `agent_run_events`. Exported as OTel spans (`execute_tool`, attributes
   to be re-checked against the moved GenAI spec).

### Policy

- Selection grants nothing. Execution re-checks permission, tenancy,
  availability and revision fences, as today.
- Untrusted code (third-party specs, user tools) never runs in-process. It
  runs in a sandbox with no tenant credentials, or not at all. Connected MCP
  tools stay read-only (`call_connected_tool`).
- Credentials are injected server-side and never appear in schemas or
  results (the treg pattern).

### Evals that gate the switch

- **Routing recall@k:** the expected capability is in the top-k. Precision:
  disallowed capabilities never appear.
- **Whole-task state:** tau-bench style, graded on rows and adapter calls.
- **Shadow mode:** route in parallel with `commandTools` and compare recall
  and bytes before replacing it. Success means bytes per step fall at least
  50% with no loss in whole-task pass rate. Both numbers are to be measured.
  Neither is claimed now.

### Explicitly not in M1.5

- graph or vector memory;
- third-party registries;
- automatic capability authoring;
- any new external effect.
