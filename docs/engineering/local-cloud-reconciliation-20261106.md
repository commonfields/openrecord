# Local/cloud reconciliation — 2026-11-06

The first consolidation preserved local work but did **not** integrate all of
`22ae8ad` (`backup/local-development-20261106`). The visible regressions reported
by the user were real omissions, not merely a stale browser. Worktree cleanup
was incorrectly presented as more complete than feature reconciliation.

## Validation

- All 278 web tests passed, including conversation proposal scoping, durable
  client polling, text-only menu and single-composer presentation guards.
- 73 inference/run/queue/setup tests and 24 campaign/proposal integration tests
  passed against stand-ins and isolated PostgreSQL. Current campaign revision,
  proposal approval and durable worker safeguards remain covered.
- API/web typechecks and targeted production/test TypeScript lint passed during
  reconciliation; final rerun recorded in the pull request.
- No live publication, Google mutation or spending was used for validation.

## Baseline retained from merged main

PRs 124–129, chart/table replies, plugins and usage, campaign progress and manual
editor, exact revision/receipt protections, Google account actions, Markdown W7
execution, durable queue and stronger standalone worker fencing remain present.
The queue, worker/runtime launchers, campaign backend/contracts/migrations, date
picker and campaign commands from the local snapshot were already integrated.

## Restored or adapted in this branch

- Chat proposal lists require explicit conversation references. Business-wide
  accepted buyer-question drafts no longer appear in every chat. Linked accepted
  drafts start collapsed. Existing records are not deleted.
- Empty/loading/history chats share one thread and composer geometry. Late
  replies are fenced to the current conversation scope. Resizable split pane,
  text-only slash menu and quieter agent controls are restored. Cloud playbooks,
  sharing, model choice and rendering remain available.
- Durable client submission, reconnection, reload/history reattachment and
  request cancellation use the current server API. Detaching does not cancel,
  and ambiguous interrupted work is not resubmitted automatically.
- Answer-only inference recovery, honest partial findings, request/deadline
  budgets, 8192-token output default, auth/cancellation classification, scoped
  finding checkpoints and resume context are restored alongside cloud guidance.
- Minimal Add business/start form, client/product setup entry points and
  opted-in persisted background setup are restored. Legacy setup requires an
  explicit Continue. Facts are not approved by the scheduler; first work stays
  proposed, not authorized or executed.
- Local AI-answer/discovery entry points, clearer evidence-report presentation,
  styled access checkbox, visible channel tool section and navigation copy are
  restored without dropping cloud plugins or account-action inbox cards.
- Recovery/product notes and regression tests are recovered/adapted.

## Deliberate differences from the snapshot

- Historical migrations 0069/0074 are adapted as 0080/0079; old numbers are not
  replayed out of order. Already merged 0075/0076 remain authoritative.
- Keep current investigation-state validation rather than the older snapshot's
  schema-narrowing workaround. Keep current cloud campaign presentation instead
  of restoring its older manual-editor default.
- A bridge that is not ready remains unavailable; the actual polling timeout is
  classified TIMEOUT. The snapshot incorrectly changed readiness to timeout.
- Tests are adapted to current layers, honest recovered outcomes and current
  UI labels; older duplicate assertions are not copied mechanically.

## Browser verification before rollout

At localhost:3000 the empty chat and a populated Cueup history both measured
688px composer width and 74px height in the same viewport. The unrelated accepted
buyer-question draft was absent. Slash commands and cloud playbooks rendered
with zero icons and no descriptions. No message, approval, publication or spend
was submitted during this UI check. Backend changes require migration/restart.
