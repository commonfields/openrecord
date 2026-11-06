# Marketing-native, agent-native operating loop

Adapted from the corrected Comprehensive Marketing Module supplied on
2026-11-06, including its distribution layer. This is product-owned guidance,
not a remotely loaded skill or authority to perform external actions.

## Experience

One goal, one current campaign, one next action. Chat is the interface; campaign
revisions, drafts, proposals and delivery receipts preserve the work.

`/marketing` reads the business's prioritized work queue and advances a requested
permitted step. Ordinary conversation works too. Status-only requests stay
read-only. The agent should research, write concrete copy and save usable work,
not send the user another generic checklist. It asks one essential question
when a missing decision prevents useful work.

The loop is:

goal → customer/offer → campaign → distribution → approved delivery → outcomes
→ decision → next experiment.

## This increment

- `read_marketing_work` derives bounded, scoped actions from persisted campaigns
  and current adapter-backed run reports. It distinguishes agent work, human
  decisions and product capability gaps; there is no marketing score.
- Optional structured distribution plans preserve the primary channel and its
  rationale, owned/earned/paid/product-led/hybrid motion, funnel stage,
  destination, cadence, proposed budget, conversion event and tracking plan.
- Existing draft/revision tools save these plans with their normal replay,
  audit and optimistic concurrency protections. Old campaigns remain readable;
  no database migration is required for this JSON brief extension.
- One `/marketing` command can use existing research, campaign preparation,
  WordPress and account-action proposal tools. It adds no new approval power,
  external executor or background automation.
- Campaign progress shows distribution in a collapsed disclosure. Manual
  editing remains available; the default experience is conversation, not a form.
- Prior closed-campaign learning is returned as operator-recorded candidates,
  with originating campaign/revision and relevance explicitly unassessed. The
  agent must check relevance and uncertainty before reusing it.

Assessment examines at most ten campaigns from the most recent hundred,
prioritizing reviews due in that window. It returns at most thirty actions and
five learning candidates with explicit coverage. A specific campaign can be
read even when it is older than that portfolio window. Never describe a
truncated assessment as the complete business portfolio.

## Remaining blockers to the complete product

| Blocker | What counts as completion |
| --- | --- |
| Business-wide strategy | Versioned ICP, positioning, priority bets and resource/stop criteria shared across campaigns, not just campaign audience/message fields. |
| Prelaunch measurement | Campaign-bound tracking configuration and independently observed test-event evidence; a written tracking plan is insufficient. |
| Measured outcomes | Source-bound immutable readings with metric definition, window, baseline comparability, freshness and explicit attribution limitations. |
| Review rhythm | Opt-in durable scheduled reviews with budgets, cancellation and duplicate prevention; a review date is not a scheduler. |
| Quality acceptance | Independent brand, factual-claim, offer and tracking checks tied to the exact deliverable revision, not the drafting agent's own approval. |
| Delivery breadth | More campaign-bound adapters and receipts. The current campaign playbook links WordPress only; separate supported account actions are not campaign receipts. Email/social delivery remains a handoff. |
| Coordination | Real scoped member assignments, dependencies and notifications; owner labels do not assign or notify a person. |
| Compounding learning | Relevant outcome-backed learning demonstrably improves the next decision compared with a generic-agent baseline; returning prior notes is not proof. |

These are product engineering gaps, not a checklist the customer must complete
or facts the model can assert into existence.

## Boundaries and acceptance

- A distribution budget is a proposal, not spending permission. A connection
  is not a distribution strategy. A saved cadence does not schedule sending.
- Draft readiness is neither independent quality approval nor evidence of
  publication. Pending approval, verification, cancellation and failed/rejected
  delivery must come from current scoped receipts, not assistant claims.
- Revision conflicts, non-draft campaigns and linked delivery proposals retain
  the existing edit refusals. Never overwrite decisions or create an unrequested
  duplicate to work around a refusal.
- Publishing, sending, account changes and spending retain exact human approval
  and verification. Do not replay ambiguous external effects.
- Outcomes must fit the business: qualified enquiries, appointments, purchases,
  activation, retention or expansion. Clicks and reach may be useful leading
  indicators but do not establish revenue or campaign-caused uplift. Platform
  attribution totals are not additive.
- Tests must cover scope, replay, unchanged decisions/task IDs, old brief
  compatibility, plan persistence, current run states, queue coverage and an
  agent turn that saves actual work. Stand-in tests are not a claim of live
  provider or end-to-end marketing effectiveness.

Next implementation priority: verified prelaunch tracking and campaign-bound
outcome evidence, followed by durable review scheduling. Finish the web loop
before starting Rune desktop development.
