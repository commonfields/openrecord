# Growth opportunities P1 reference

This change implements OPENRECORD_GROWTH_DELIVERY_V1 phase P1. It adds manual product onboarding, a versioned primary goal, and reviewable growth opportunities.

## Repository

- Base and local origin/main: `2bec7a5611d7f4e40a1b8d01e621f39338268720`.
- Branch: `feat/growth-workspaces-opportunities-v1`.
- Migration: `0030_growth_opportunities_v1.sql`. Migrations 0031 and 0032 remain reserved for later phases.

## Persistence

`Business` and `record_profiles` retain product identity and engagement. Registration calls `RecordRepository.createClient` inside the same transaction as growth-profile creation. `DOGFOOD` and `CLIENT` remain explicit operator assertions. A URL grants no publication or repository authority.

`growth_profiles` holds category, audience, value proposition, the one primary goal pointer, and update attribution. `growth_goals` holds immutable metric versions and author attribution. A changed definition appends a version. Identical definitions reuse the current version. Existing opportunities retain their original goal foreign key.

The metric definition contains goal kind, `GA4_AGGREGATE_EXPORT`, GA4 event name, `EVENT_COUNT`, IANA reporting timezone, and an optional property reference. Event counts are not distinct people. Distinct-user semantics require a later contract and migration.

`growth_opportunities` holds the immutable opportunity specification, owner, source, baseline availability, and creator attribution. `growth_opportunity_events` holds append-only lifecycle events. The current status, revision, update time, and editor derive from the latest event. `growth_opportunity_evidence` holds typed source references and authorship notes. `growth_registrations` holds account-scoped registration request identities.

Business/account locks serialize registration, opportunity creation, and goal edits. Opportunity row locks serialize decisions. Repeated request keys replay the original resource. A decision replay must match its original target state, reason, expected state, and expected revision. Opposing concurrent decisions produce one event and one stale-decision refusal.

## Authority and lifecycle

The pure `GROWTH_TRANSITIONS` table in `packages/contracts/src/growth.ts` defines authority. Integration tests compare the database trigger against the table.

| From | To | Authority |
| --- | --- | --- |
| Initial | DISCOVERED or PROPOSED | Operator or assistant |
| DISCOVERED | PROPOSED | Operator or assistant |
| PROPOSED | APPROVED | Operator only |
| DISCOVERED, PROPOSED, or APPROVED | CANCELLED | Operator only, with a reason |
| Any | IN_DELIVERY, DELIVERED, MEASURING, or REVIEWED | Refused in P1 |

P1 exposes operator promotion through HTTP. The agent creates proposals directly.

`GrowthActor` names future `DELIVERY_SYSTEM` and `MEASUREMENT_SYSTEM` authorities. They have no P1 HTTP or tool dispatch path. P2/P3 must extend both the pure policy and database guard when they attach authoritative records.

## Evidence and isolation

`OBSERVED` references must resolve to stored evidence in the selected business. Supported kinds are observation, record check, record judgment, acquisition batch, acquisition result judgment, GA4 referral import, and record action. Empty checks/batches and synthetic observations/imports do not qualify.

Operator creation requires `OPERATOR_HYPOTHESIS` authorship. Assistant creation requires `MODEL_SUGGESTION` authorship. Observed references do not turn a proposed mechanism into a verified result. Both the repository schema and database trigger refuse `VERIFIED_ACTION` and `MEASURED_OUTCOME` writes in P1.

HTTP routes use the authenticated session, `BusinessRepository.getScoped`, strict request decoding, and the existing origin guard. Foreign or missing business, opportunity, goal, and owner IDs produce 404. Unknown errors return generic responses without SQL details. Browser page context grants no permissions.

## API

All opportunity paths below are under `/api/growth/clients/:id`.

- `POST /api/growth/products`: atomic registration with a client request key.
- `GET /api/growth/clients/:id`: growth profile and goal versions.
- `PUT /api/growth/clients/:id`: human-authored profile and primary-goal update.
- `GET /opportunities`: latest 50 opportunities, including evidence and event history.
- `GET /opportunities/:opportunityId`: one scoped opportunity.
- `POST /opportunities`: operator-authored discovered or proposed opportunity.
- `POST /opportunities/:opportunityId/propose`: operator promotion for review.
- `POST /opportunities/:opportunityId/approve`: operator approval.
- `POST /opportunities/:opportunityId/reject` and `/cancel`: operator cancellation with a reason.

Decisions require `expectedStatus`, `expectedRevision`, `idempotencyKey`, and `reason`. Invalid payloads return 422. Stale decisions, conflicting request identities, and illegal transitions return 409.

## Agent

`read_growth_goal` reads scoped positioning and the human-authored metric. `read_growth_opportunities` reads at most five bounded summaries with evidence types and citations.

`propose_growth_opportunity` creates an assistant-attributed `PROPOSED` opportunity. The server validates observed references, drops unavailable references, and reports their count. Missing evidence stays a labelled model hypothesis. Baseline availability remains `UNKNOWN` for agent proposals. No approval, cancellation, goal-editing, delivery, or measurement tool is exposed.

Changes to `agent.ts` are limited to imports, declarations, dispatch, and one system-prompt paragraph. `runConversation` remains unchanged for the concurrent sanitisation work.

## Web

`/products/new` registers an owned product or authorized client with manual positioning and a trial-signup goal by default. The new product enters the shared business selector after registration. Review dialogs retain the state and revision that the operator opened, including after an error or retry.

`/clients/:id/growth` shows the profile, exact goal definition, opportunities, owner and creator attribution, evidence badges and stored-source links, lifecycle history, and human review dialogs. Existing Client Record, AI Discovery, Overview, and Operator Agent links remain available. Existing URLs remain unchanged.

Shared UI edits are limited to entry links, the workspace route, growth citation links, and breadcrumbs. `api.ts` remains untouched because the growth client reuses its existing `api` function.

## Verification environment

All database operations use PostgreSQL 16 in `or-p1-ce71-pg`, exposed only on `127.0.0.1:55811`. Test fixtures use a new database inside that container. The API and web smoke use ports 55812 and 55813. No operator database or existing development server is used.

A temporary local runner supplies disposable-database settings and Node 24.3.0 without printing credentials. It disables external agent processing and 9Router. The runner and `apps/web/vite.p1.local.ts` are removed before delivery.

## Scope limits

P1 completes product registration, goal definition, opportunity proposal, human approval or rejection, and persistent status review. GitHub delivery and general GA4 outcome imports are separate P2/P3 work. No delivered work, measured growth, deployment, or customer-acquisition result is claimed.

Opportunity lists are bounded to the latest 50 in the UI and latest 100 in the repository. Goal history reads the latest 100 versions. Source links for record and acquisition judgments open their existing workspace views. They do not introduce new evidence detail routes.

## Browser verification

The T3 collaborative browser exercised an authenticated fixture account against the isolated API and database:

1. Registered a DOGFOOD product through `/products/new` with manual positioning and a trial-signup event definition.
2. Created an opportunity through the UI and approved it with a human reason. A fresh API read returned revision 2 and exactly `PROPOSED`, `APPROVED` in history.
3. Rejected another proposal through the UI. A fresh read returned `CANCELLED` and exactly two events.
4. Changed `trial_signup` to `trial_started` through the profile editor. The primary metric became version 2. Existing opportunities kept version 1 and `trial_signup`.
5. Opened a rejection dialog, committed a concurrent human approval through the API, and submitted the stale dialog. The UI displayed the stale-review message. The opportunity stayed approved at revision 2 with two events. Retrying the same dialog also refused the stale decision without adding an event.
6. Inspected the workspace at desktop 1280x800 and mobile 390x844. Neither viewport had horizontal document overflow.
7. Opened the preserved Client Record and AI Discovery routes without starting measurements or calling a model.

A hot reload reset an open review dialog during an intermediate check. After reopening the dialog, rejection passed. A restarted API served the final backend source for the stale-review check.

## Existing-test review

The resumed changes to these integration tests add only `GrowthRepositoryLive` to imports and Effect test layers:

- `apps/api/src/agent-acquisition.integration.test.ts`
- `apps/api/src/agent-conversations.integration.test.ts`
- `apps/api/src/agent-proposals.integration.test.ts`
- `apps/api/src/agent-referrals.integration.test.ts`
- `apps/api/src/agent-tools.integration.test.ts`
- `apps/api/src/observation-semantics.integration.test.ts`
- `apps/api/src/stack-workflow.integration.test.ts`

The new tools extend `AgentToolDeps`, and `makeRouter` includes the growth routes. These existing test environments therefore need the new repository service. Their assertions remain unchanged. `agent-tools.test.ts` adds the two registered read tools to its exact allowlist.

Intentionally untouched code includes `runConversation`, the shared `api.ts` transport, existing workers, P2/P3 migrations and implementation, Jev, production configuration, and all other worktrees.
