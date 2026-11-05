# Approval-gated Google account actions

This integrates the code originally merged by PR 117 into a WordPress feature
branch, not into main. It preserves the current campaign, plugin, usage and
conversation-linked inbox flows rather than restoring the historical UI.

## Boundaries

- Agent tools can read connected reviews/campaigns or prepare an exact proposal.
- Preparation reads the current target and uses Google Ads `validateOnly` for
  ad mutations. It does not publish a reply or change campaign spending/status.
- Only authenticated operator approval routes perform writes. Scope is checked
  against the business and its current account bindings. Tokens never reach
  model inputs or client responses.
- Replies replace only the approved review's reply. Budget changes refuse shared
  or non-daily budgets and increases greater than twice the prepared amount.
- Enabling a campaign displays and pins its existing budget; a changed budget
  blocks approval. This is not a lifetime spending cap or a performance promise.
- New search ads must point at the business's own site and are always PAUSED.
  Verification compares headlines, descriptions, destination URL and both display
  paths, not merely the fact that an ad exists.

## Lifecycle and failure

Approval claims PROPOSED → EXECUTING once before provider calls. Undo independently
claims DONE → UNDOING once, checks the target has not changed, and verifies the
previous values (or removal of a newly created ad) after the write.

Failures and unknown outcomes are not automatically retried. Provider timeouts
may mean a write succeeded without a readable response; inspect Google before
preparing another action. A process crash can leave EXECUTING or UNDOING rows
requiring manual inspection. There is no automatic replay or crash reconciliation
for external account writes. Read-before-write checks do not eliminate a race
with a human editing Google between the read and the mutation.

Rejections use the existing optional reason workflow. Approval/rejection feedback
is available to the marketing loop, and originating conversations remain scoped
to the current user.

## Migration and validation

Run `0077_account_actions_v1.sql` before restarting API and agent workers. It also
upgrades the status constraint for databases that ran the older feature-branch
schema and permits ACCOUNT_ACTION decision feedback. No credentials or external
calls are required to migrate.

Validation uses scripted provider responses and an isolated PostgreSQL database.
It checks once-only approval/undo, stale targets and budgets, private tenant/origin
boundaries, exact ad readback, own-site restriction, paused creation and token
redaction. Client rendering tests cover proposal details, non-retryable in-flight
and failed states, and undo availability. These are not live Google acceptance
tests; no real ads, replies or budgets should be changed during consolidation.
