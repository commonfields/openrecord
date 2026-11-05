# Campaign progress and decisions

Campaigns open as a full-width list, not a brief editor. Select a campaign to
review its goal, audience, saved deliverables, preparation status, blockers,
recorded results and suggested next step. Continue with the agent is the primary
action; Edit details preserves the manual workflow and revision checks.

The list's stage comes from the saved brief. It never represents a background
worker's liveness or verified launch. The detail view separately reads current
preparation runs and adapter receipts. Stale and cancelled runs remain explicit.
Task completion and result text are human attestations; linked delivery evidence
is not proof of whole-campaign delivery or causal impact. Nothing on opening this
page approves, publishes, spends or starts a run.

This PR also includes the previously uncommitted campaign foundation: contracts,
account-scoped routes, draft/revision/run agent tools, migrations 0070–0073 and
their tests. It excludes the separate durable request-worker feature. Apply the
normal database migrations before starting the API. No live provider acceptance
or visual browser walkthrough is claimed by the fixture tests.
