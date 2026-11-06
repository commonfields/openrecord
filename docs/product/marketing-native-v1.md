# Marketing-native product: first implementation

Recovered local design notes, reconciled with current campaign progress.

OpenRecord coordinates campaigns, people and agents across existing tools. The
durable unit is a campaign, not a conversation or a connection. The intended
loop is goal → brief → deliverables → launch → results → decision → experiment.

## Implemented boundaries

- Persisted briefs, audience, offer, message, hypothesis, deliverables and handoffs.
- Owners/dates are planning labels, not member assignments or notifications.
- Readiness/closure checks, optimistic revisions and attributed audit records.
- Conversational drafts and revision-aware editing preserve unchanged content,
  task IDs, human decisions and results. Edits refuse stale/non-draft campaigns,
  completed tasks and linked delivery proposals rather than overwriting them.
- Campaign commands use the normal selected-agent conversation. The page starts
  with conversation; the manual editor remains available.
- Durable bounded preparation runs pin a brief revision and local playbook.
  Concurrent starts replay, changed revisions become stale, and cancelled
  revisions remain cancelled. Preparation allows at most 30 deliverables and
  makes zero external calls through these coordinator tools.
- Same-business WordPress receipts can link once to a deliverable; links cannot
  replace existing links or reuse a change across tasks. Scope is verified;
  correspondence between receipt and copy still requires human review.
- Stopping an internal run does not cancel or undo external work. Existing
  provider adapters retain their separate human approval boundaries.
- Durable chat requests, worker fencing, safe pre-execution recovery, finding
  checkpoints and client reattachment preserve completed work without replaying
  ambiguous effects. Checkpoint migration is now 0079, not historical 0074.

This is planning and manually recorded review, **not** autonomous campaign
execution or attribution. Evidence links/results are operator assertions, not
verified measurements. A review date is not an automatically scheduled review.
Draft readiness checks presence, not independent marketing quality.

## Next increments

The first agent-native work-queue and structured distribution increment is
described in [marketing-agent-operating-loop.md](marketing-agent-operating-loop.md).
It makes the gaps actionable through existing tools; it does not close the
verified measurement, delivery breadth, scheduling or collaboration gaps below.

1. Independent content, brand and tracking review with deliverable acceptance.
2. More campaign-bound proposal/receipt adapters, preserving exact approval.
3. Verified tracking, source-bound outcomes and opt-in budgeted review scheduling.
4. Real member assignments, dependencies, notifications and collaboration.
5. Demonstrated learning reuse evaluated against a generic-agent baseline.

Do not claim a moat until accumulated learning demonstrably improves decisions.
Fixtures and typechecks are not live connected-provider acceptance.

```text
/campaign Get more qualified demos from existing trial users
/campaign-status
/campaign-run Trial activation
/campaign-review Trial activation
```

Preparation is not blanket permission to publish or spend; review recommends a
decision rather than recording a human-approved outcome or invented attribution.
