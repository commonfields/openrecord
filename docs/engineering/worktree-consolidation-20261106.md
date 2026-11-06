# Checkout consolidation — 2026-11-06

The canonical development directory is `/Users/wira/openrecord`. The merged
baseline at the start of this audit was `479711135e56` (PRs 124, 125 and 126).
Do not run development from the historical feature worktrees or merge their
old snapshots wholesale over current main.

## Preservation

All previously uncommitted source changes were committed to the following
backup branches and pushed to origin before cleanup. These snapshots are
recovery points, **not a claim that their contents are integrated or tested**.
No branch history, database volume, credential file, or private data was deleted.

| Checkout / work | Recovery branch | Commit |
| --- | --- | --- |
| Original local campaign, inference, setup and UI edits | `backup/local-development-20261106` | `22ae8ad` |
| Unified candidate test | `backup/unified-candidate-20261106` | `b3e136c` |
| Unified verification tests | `backup/unified-verification-20261106` | `90459d7` |
| Agent referral work | `backup/agent-referrals-20261106` | `4087ea7` |
| Research catalog / live task runner | `backup/research-catalog-20261106` | `84ae98e` |
| Stack readiness test | `backup/stack-readiness-20261106` | `1579063` |
| Read-only GA4 validation probe | `backup/ga4-validation-20261106` | `3bbdbfa` |
| Older WordPress implementation | `backup/wordpress-20261106` | `5cb9691` |

## Safe cleanup

The temporary `openrecord-latest` worktree was clean and removed after the
session and services moved back to the canonical directory.

These additional checkouts are eligible for removal with ordinary
`git worktree remove` (no force), after verifying they remain clean:

- `openrecord-campaign-progress`: branch is an ancestor of main, merged by PR 126.
- `openrecord-worker-pr`: branch is an ancestor of main, merged by PR 125.
- `openrecord-wt-agent`: branch is an ancestor of main.
- `openrecord-wt-wp2`: branch is an ancestor of main.
- `openrecord-wt-acq-validation`: every unique commit has a patch-equivalent on main (`git cherry` reports only `-`).
- `openrecord-wt-harness`: its durable-run commit has a patch-equivalent on main.

Branches are retained after worktree removal. Generated dependencies/build
artifacts do not need committing. The ignored-file audit found no private
configuration in these six checkouts; the campaign bridge bundle is generated.

## Remaining integration work

Checkouts with genuinely unique changes must remain until those changes are
reconciled and validated. A clean working tree or a backup commit alone does not mean safe to delete.
Several histories are roughly 200 commits behind main, with squash/rebase
duplicates and conflicting implementations.

| Branch / snapshot | Required action |
| --- | --- |
| `backup/local-development-20261106` | Reconciled on `fix/reconcile-local-chat-inference-20261106`: restored conversation-scoped drafts, stable composer layout, text-only slash menu, minimal Add business, inference recovery/checkpoints, durable client reattachment and background setup while retaining newer cloud features. See `local-cloud-reconciliation-20261106.md`; preservation alone was not integration. |
| `feat/account-actions` (`b992e16`) | Integrated by PR 128 with current inbox/feedback, migration 0077, claimed/verified undo, complete ad readback and stale-budget safeguards. Original clean checkout removed after merge; pushed history retained. No live provider writes were used for validation. |
| `feat/growth-github-delivery-v1` | Adapted into W7 by merged PR 129 with migration 0078 and existing approval/worker safeguards. Original clean checkout removed after validation/merge; pushed history retained. Obsolete 0031 was not replayed. Rendered deployment remains explicitly inconclusive. See `docs/architecture/markdown-connected-execution.md`. |
| `backup/research-catalog-20261106` | Reviewed: live-task runner, web readers and network module match main exactly; invalid-input assertions are already applied. Remaining differences are newer tools, metering and expanded instructions on main. No unique change remains. |
| `backup/wordpress-20261106` | Reviewed: client, client tests, integration tests, server implementation and migration match main exactly. Registration, receipts, approvals, transport POST/body support and UI are present; main additionally extracts the API module, masks passwords and captures rejection reasons. No unique change remains. |
| `backup/agent-referrals-20261106` | Reviewed: tool and draft implementation already present. Main extends reporting with pending/attempt counts, citation provenance, bounded measured surfaces, safer fixture clocks and additional evidence links. Old registration and export changes are included. No unique change remains. |
| Unified candidate / verification / direct / UI and stack readiness branches | Reviewed: their older workflow tests are superseded by the current test. The direct branch's test differs only in newer repository-layer wiring; its worker fixture matches main. Earlier tests are subsets of the current worker-backed workflow with stronger provenance, referral and unauthenticated-access assertions. Other commits are patch-equivalent to main. No unique change remains; do not restore the historical UI. |
| `backup/ga4-validation-20261106` | The independent read-only probe is included in this maintenance change. Its checkout can be removed after this change merges. |

## Validation and limitations

The cloud feature PR 124 passed hosted and CLI CI. PR 126 subsequently introduced
one stale web test expectation: `sectionTitles` includes Campaigns but the test
did not. This maintenance change aligns that expectation with the shipped route.
At the merged baseline, API/web typechecks passed and 262 of 263 web tests passed.
With the breadcrumb expectation corrected, all 263 web tests pass.

Only offline self-tests should run for the GA4 probe during consolidation.
Its live mode requires explicit operator credentials and writes results outside
the repository; cleanup must not contact Google or run publishing queues.
