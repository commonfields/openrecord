# Marketing-native product: first implementation

## Direction

OpenRecord coordinates campaigns, people and agents across existing tools. The durable unit of work is a campaign, not a conversation or a connection. The intended loop is goal → brief → deliverables → launch → results → decision → next experiment.

## Implemented

- `/businesses/:id/campaigns`, available from the workspace sidebar.
- Persisted campaign briefs, audience, offer, message and hypothesis.
- Owners and dates are planning labels, not notifications or account membership assignments.
- Deliverables, channels, handoffs, blockers and human-attested completion.
- Pre-launch measurement definition, baseline, target and review date.
- Results, uncertainty, explicit decision, learning and next experiment creation.
- Server-side launch-readiness and closure checks. Active campaign edits can record new blockers without re-launching.
- Optimistic revision checks, transactional revision records, account-scoped access and existing origin protections.
- Agent tools `read_marketing_campaigns`, `record_campaign_draft` and `record_campaign_revision`: the agent saves private, explicitly assistant-authored briefs and draft deliverables, then applies requested patches to the existing draft. Identical inputs replay safely; retries never overwrite later human edits. Alternatives are created only when requested or editing is refused.
- Slash commands `/campaign <goal>`, `/campaign-status`, `/campaign-run <campaign>` and `/campaign-review <campaign>` use the normal selected-agent conversation. Arguments remain ordinary message text; the slash menu is discovery, not a separate execution engine. The campaign page defaults to starting with the agent; manual editing is optional.

The feature is planning and manually recorded review, **not automated campaign execution or attribution**. A review date is displayed and counted as due, not automatically scheduled with the agent. Evidence links and result text are operator assertions, not verified measurements.

## Next increments, in order

1. Independent content/brand/tracking review and human acceptance of individual deliverables.
2. Campaign-bound proposals and execution receipts, connecting supported adapters to the actual deliverable they fulfill.
3. Tracking checks, source-bound measurement and scheduled reviews with explicit opt-in and run budgets.
4. Account-member assignments, dependencies, calendar and collaboration; replace free-text planning labels.
5. Campaign-linked learning retrieval and recommendations evaluated against a generic-agent baseline.

Do not build more connectors before a team can finish one campaign and start its next experiment here. Do not claim a moat until accumulated learning demonstrably improves decisions.

## Campaign engine V1 (implemented, not a full autonomous worker)

- `record_campaign_run` persists an immutable brief snapshot and revision using a pinned local playbook (version 1). Concurrent starts of the same revision return the same run.
- `read_campaign_runs` reads the latest five runs, detects stale revisions and derives delivery state from current adapter records. It does not write state while reading or launch providers.
- `record_campaign_delivery` links an existing, same-business WordPress change to one website deliverable. Links cannot replace prior links, reuse a change for two tasks, or attach to stale/cancelled runs.
- Preparation is bounded to 30 deliverables and zero external calls by these tools. Other research/proposal tools retain their existing runtime budgets and permissions.
- States distinguish missing drafts, unsupported-channel human handoffs, review, approval, verification, observed delivery, stale runs and cancellation. Human task completion, acceptance and publication alone do not establish live delivery.
- The campaign page exposes run status, blockers and next moves. Operators can stop an internal run through the existing styled confirmation component. Stopping does not cancel external requests or undo publication. The same cancelled revision stays cancelled; a changed brief creates a new revision/run.
- Inspired by pstack's prepare/review/verify discipline at `cursor/plugins@ae5650febf4320793844c12c4adaa937f417f8da`, not a downloaded plugin or imported upstream code. No remote instructions are automatically loaded.

This is a durable preparation/receipt coordinator. It is **not** independent multi-model creative review, a background campaign executor, scheduled measurement, or automatic attribution. Draft readiness checks presence of content, not marketing quality. WordPress link scope is server-verified, but correspondence between the linked change and campaign copy still requires review. Existing WordPress publishing remains human-approved through its adapter. GitHub, email, paid and social delivery are not implemented by this playbook.

## Overall checklist status

- [x] Campaign storage, manual review, revision protection and agent-created drafts.
- [x] Conversation commands and a durable, bounded preparation run with WordPress receipt linkage.
- [x] Stale-run protection, replay-safe starts/links and internal cancellation.
- [x] Durable chat submission, standalone request workers, request-ID reconnection, late-commit protection and safe pre-execution recovery (migrations 0075–0076).
- [x] Revision-aware agent editing without creating alternative drafts (DRAFT campaigns only).
- [ ] Independent content/brand/tracking review and risk-based helper/model routing.
- [ ] Automatic approved execution dispatch and durable worker recovery.
- [ ] Campaign-bound measurement plans, scheduled results reviews and next-experiment learning retrieval.
- [ ] Real team assignments, dependencies, notifications and calendar.
- [ ] Live connected-provider acceptance test (not replaced by fixtures or typechecking).

## Validation

`apps/api/src/campaigns.test.ts` covers input bounds, launch readiness, closure decisions and invalid dates. `campaigns.integration.test.ts` uses `TEST_DATABASE_URL` for authentication, tenant isolation, origin checks, concurrent writes and transactional audit records. Never point integration tests at customer or development business data.

Campaign migrations: `packages/db/migrations/0070_marketing_campaigns.sql` through `0073_campaign_agent_revisions.sql`. Agent reliability also uses `0074_agent_finding_checkpoints.sql` and `0075_agent_request_queue.sql`. Restart the non-watching API after migration. Existing routes and local work are preserved.

## Conversational editing

After creating a campaign, the user can say “Change the audience to new trials, rewrite the welcome email, and add a follow-up email.” The agent reads the current campaign and calls `record_campaign_revision` with its expected revision and a reason. Patches preserve unspecified fields, existing task IDs, results and human decisions. New tasks are TODO. Completed tasks, non-draft campaigns and campaigns with any linked delivery proposal are not editable through this tool. It never silently changes text that may already be approved for delivery.

Each accepted edit is an attributed audit revision with its reason. Old runs become stale. Concurrent edits have one winner; an identical retry returns the recorded revision plus the current revision without writing again. These are planning writes, not evidence, publication or goal approval.

## Command examples

```text
/campaign Get more qualified demos from our existing trial users
/campaign-status
/campaign-run Trial activation
/campaign-review Trial activation
```

`/campaign-run` prepares supported proposals and handoffs; it is not blanket publication or spending permission. `/campaign-review` investigates available evidence and recommends a decision, not automatic attribution or a human-approved outcome. Commands require a configured agent in a business workspace. There is no claim of live provider validation from the deterministic tests.
