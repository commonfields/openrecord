# Objective and campaign continuity

Marketing work on one objective spans many conversations. A person asks for a
campaign on Monday, approves a page change on Wednesday, and opens a new chat
on Friday. Campaigns, runs and delivery receipts already persisted, but the
investigation that carried the objective could not name them. A fresh
conversation saw the investigation notes and had to guess which campaign they
meant. `/marketing` also could not read or write investigations.

Migration **0081** lets an investigation note name one campaign. The resume
brief then shows that campaign's live state next to the investigation.

## Lifecycle map

| Stage | State | Where |
| --- | --- | --- |
| Growth goal | Implemented. Human-authored. | `growth_goals` |
| Investigation question and notes | Implemented. Append-only, attributed. | `open_investigation`, `record_investigation_note` |
| Investigation state and follow-ups | Implemented. Stale state changes are refused. | `workState`, `wait_for_investigation` |
| Investigation to opportunity | Partial. Opportunities reference a goal, but have no structured investigation link. Assistant proposals remain hypotheses. | `growth_opportunities.goal_id`, `propose_growth_opportunity` |
| Opportunity to campaign | Missing. The two persisted work chains have no structured link. | |
| Campaign draft, revision and run | Implemented. | `record_campaign_draft`, `record_campaign_revision`, `record_campaign_run` |
| Investigation to campaign link | Implemented by 0081. Optional explanatory context. | `campaignId` on `record_investigation_note` |
| Objective to work link | Implemented by 0082. Written by the server when the work is created. | `objective_goal_id` on campaigns, WordPress changes and account actions; `readObjectiveWork` |
| Resume in a fresh conversation | Partial. Top three investigations, the latest linked campaign, and its latest run only. | `readObjectiveInvestigations`, `loadResumeContext` |
| Campaign approval and execution | Partial. Exact WordPress changes require operator approval. Run links grant no authority. Other campaign channels remain handoffs. | `wordpress_changes`, `record_campaign_delivery` |
| Campaign delivery verification | Partial. WordPress receipt and live-check state is derived separately from campaign impact. | `campaignRunReport` |
| Opportunity approval and execution | Implemented for supported site changes. An approved opportunity still needs exact change authorization before dispatch. | `growth-execution-routes.ts`, `growth_execution_events` |
| Opportunity observation and review | Implemented. Live checks, measurement plans and observed metric evaluations remain separate from operator KEEP, REVERT, EXTEND or INCONCLUSIVE decisions. | `growth_execution_live_checks`, `growth-measurement-routes.ts`, `growth-routes.ts` |
| Campaign-bound outcome measurement | Missing. | |
| Keep, change or stop decision | Human only. The agent recommends and never saves it. | |
| Continuing without a person in the chat | Missing. Wake-ups are opt-in and read-only. `/marketing` works only inside a turn. | |
| Email and social sending, member assignment | Missing. | |

## Alternatives considered

**A link table.** A `growth_investigation_campaigns` row per investigation and
campaign would allow many links and an explicit "current" campaign. It also
needs its own request keys, its own state-change fencing and its own history,
which the note table already has. A mutable "current" pointer can be reverted
by a late retry, which is the failure this work exists to prevent.

**An investigation column on the campaign.** `marketing_campaigns` is a
mutable brief with revisions. A column there ties each campaign to one
investigation and can be overwritten by any brief save. The campaign would
also have to know about investigations, which nothing else in the campaign
code needs.

The note link wins because notes are already append-only, attributed and
replay-safe. A link inherits all three without new machinery.

## Shape and invariants

`growth_investigation_notes` gains two nullable columns, `campaign_id` and
`campaign_revision`.

- Both columns are set or both are null, and `campaign_revision` is positive.
  `growth_investigation_notes_campaign_link_check` enforces this.
- `(business_id, campaign_id)` references `marketing_campaigns(business_id, id)`.
  A raw insert that names another business's campaign fails in the database.
- The immutability trigger from 0052 covers the new columns. A link is never
  added to, or removed from, an existing note.
- The model passes `campaignId` and optionally `expectedCampaignRevision`.
  Progress after a campaign write uses its returned revision as this fence.
  The server reads the revision with
  `FOR SHARE` inside the note transaction, after it locks the investigation.
  A campaign edit waits until the note commits. An expected revision mismatch
  refuses the link, so intervening edits are not attributed to the saved work.
  Without a fence, the revision means only the revision at link time.
- An unlinked note keeps its original request key byte for byte. A linked note
  appends the campaign ID and the expected revision when supplied, never a
  freshly queried revision. Identical progress text at a new expected revision
  is new work; the original retry still reuses its original note.
- The replay check runs before the campaign lookup. A retry after a campaign
  edit returns the original note and its original `notedRevision`. It does not
  write a duplicate or restore an older work state. The tool returns `reused`
  to distinguish an existing note from a new save.
- The note stores no campaign status. `readObjectiveInvestigations` finds the
  latest linked note for each investigation, even when it is older than the
  four notes shown. It reads status through `readCampaignRuns`, which uses
  `campaignRunReport`. Only the latest run is read. Its revision is also used
  for `currentRevision`, so the stale comparison uses the same revision as
  the run report. A failed read produces `UNAVAILABLE` for that campaign
  without losing the goal or investigations. The summary keeps deliverable state
  counts, `notedRevision`, `currentRevision` and `revisionChanged`.
- `/marketing` adds `read_investigation`, `open_investigation` and
  `record_investigation_note`. `/status`, `/report` and the `/campaign*`
  commands keep their tool sets. `wait_for_investigation` stays out of
  `/marketing`, and its schema does not accept `campaignId`.
- `MARKETING_OPERATING_POLICY` tells the agent to recover objective work first
  and to link saved campaign work with one note. Read-only assessments record
  nothing.

## Objective lineage (0082)

The note link above depends on the model. Migration 0082 adds a link that
does not. `marketing_campaigns`, `wordpress_changes` and `account_actions` gain
a nullable `objective_goal_id`. The creating `INSERT` fills it from
`growth_profiles.primary_goal_id` in the same statement:
`draftMarketingCampaign`, the operator campaign create route, `prepareChange`
and `prepareAction`. Deliverables live in the campaign brief and runs
reference their campaign, so both inherit it.

- Null means the objective was unknown (no growth profile) or the row predates
  0082. There is no backfill and nothing is guessed.
- The model cannot supply it: tool inputs reject unknown properties.
- `(objective_goal_id, business_id)` references `growth_goals(id, business_id)`,
  so a row can name only a goal of its own business.
- A trigger refuses any later change, including adding a link to a null row.
- `readObjectiveWork` recovers the work by business and goal: the current
  goal version first, earlier versions labelled `currentObjective: false`,
  and at most 10 of each kind. `readObjectiveInvestigations` returns it as
  `objectiveWork`, and the resume brief includes up to 5 of each.
- A WordPress change delivered for a campaign created under a different goal
  version is reported as `objectiveMismatch`, not refused.
- Investigation notes are unchanged and remain explanatory context only.

## Limitations

- Which investigation a piece of work advances still depends on the model
  following the policy. The server does not require a note after saved
  campaign work, and no live-model eval checks it. Which objective the work
  falls under no longer depends on the model (0082).
- Each investigation shows only its latest linked campaign. A later link to a
  different campaign replaces it in the summary, and history keeps both.
- `VERIFYING`, `WAITING_FOR_APPROVAL` and a saved plan are not delivery or
  success. `DELIVERY_OBSERVED` is not measured impact. The resume header says
  so, but the agent can still misstate it.
- Each linked campaign adds a scope check, a revision query, a latest-run
  query, and at most one delivery query. At most three campaigns are read.
  Reads are observations at query time, not an authorization snapshot. Every
  later write must still pass its own revision and permission checks.
- The operator HTTP note route does not accept campaign links.
- No new execution authority, provider call, background work or adapter
  change comes with this work. Tests use fixture models and a disposable
  PostgreSQL database.

## Deployment

Apply migration 0081 before restarting the API and standalone agent worker.
Existing notes keep null links. No backfill assigns campaigns by guessing from
conversation text. This increment does not require new environment variables.

## Local verification

With `TEST_DATABASE_URL` set to a migrated disposable database, run:

```sh
pnpm --filter @openrecord/api exec vitest run \
  src/objectives.integration.test.ts src/campaigns.integration.test.ts \
  src/agent-request-queue.integration.test.ts src/wordpress.integration.test.ts \
  src/agent-resume.test.ts src/marketing-work.test.ts src/campaign-engine.test.ts
```

The workflow persists a campaign and linked
investigation note, simulates a lost model reply, and retries without duplicate
records. A separate empty-history conversation receives the linked campaign's
current `VERIFYING` state. A subsequent campaign edit surfaces `STALE`.
Fault cases include an invalid current run snapshot, an invalid historical
run, an intervening campaign edit, a concurrent campaign edit and a stale
expected revision. Worker recovery tests refuse replay after execution may
have begun. WordPress
fixture tests require exact operator approval and distinguish publication from
live verification. These checks use PostgreSQL, fixture models and a fixture
WordPress transport. They do not prove live provider behavior or marketing
effectiveness.
