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

These checkouts must remain until their unique changes are reconciled and
validated. A clean working tree or a backup commit does not mean safe to delete.
Several histories are roughly 200 commits behind main, with squash/rebase
duplicates and conflicting implementations.

| Branch / snapshot | Required action |
| --- | --- |
| `backup/local-development-20261106` | Integrate unreleased inference recovery, client request reattachment and setup changes while preserving the newer campaign UI, plugins, usage and marketing loop. |
| `feat/account-actions` (`b992e16`) | Review and integrate approval-gated Google review replies and Google Ads changes; conflicts in registry, routing, API client and approvals. Do not enable external execution as part of cleanup. |
| `feat/growth-github-delivery-v1` | Reconcile the older delivery contracts/repository/UI against today's delivery implementation; broad conflicts make a blind merge unsafe. |
| `backup/research-catalog-20261106` | Reconcile agent/research tool changes, preserve the live-task runner, run tests. |
| `backup/wordpress-20261106` | Compare against the newer merged WordPress publishing implementation; retain any unique safety or validation changes without restoring old UI/routes. |
| `backup/agent-referrals-20261106` | Compare against the already-present referral implementation; reconcile differing tests/tools and evidence semantics. |
| Unified candidate / verification / direct / UI and stack readiness branches | Deduplicate older workflow tests against the existing `stack-workflow.integration.test.ts` and worker fixture; preserve useful unique assertions. Never replace newer workspace UI with a historical integration snapshot. |
| `backup/ga4-validation-20261106` | The independent read-only probe is included in this maintenance change. Its checkout can be removed after this change merges. |

## Validation and limitations

The cloud feature PR 124 passed hosted and CLI CI. PR 126 subsequently introduced
one stale web test expectation: `sectionTitles` includes Campaigns but the test
did not. This maintenance change aligns that expectation with the shipped route.
At the merged baseline, API/web typechecks passed and 262 of 263 web tests passed.

Only offline self-tests should run for the GA4 probe during consolidation.
Its live mode requires explicit operator credentials and writes results outside
the repository; cleanup must not contact Google or run publishing queues.
