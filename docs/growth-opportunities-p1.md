# Marketing control-plane W0 contract

W0 reconciles the unmerged P1 schema before delivery or measurement work
continues. Business and Record profiles remain the identity and tenant boundary.

## Goals and metrics

Profile requests carry positioning, `goalStatement`, and `metric`. Goals and
metric definitions have separate immutable IDs and versions. Changing only the
statement reuses the definition. Identical definitions are reused. A source,
selector, timezone, unit or currency change creates a new definition. Existing
initiatives keep their original goal and its exact definition.

Definitions support `LEAD`, `SIGNUP`, `PURCHASE`, and `BOOKING`, plus an operator
label. Source identity and IANA timezone are required:

| Source | Selector and identity | Values |
| --- | --- | --- |
| `GA4_AGGREGATE_EXPORT` | Property reference and event name required | `EVENT_COUNT`, `COUNT`, no currency |
| `OPERATOR_AGGREGATE_EXPORT` | Named system/account; event name is null | `EVENT_COUNT` / `COUNT`, or `SUM` / `CURRENCY_MINOR` with a three-letter uppercase currency code |

Currency minor units are explicit: USD values are cents, for example. No FX,
revenue attribution, unique-person counts, CSV importer or analytics engine is
introduced. Source identity remains an operator assertion, not authenticated
access to the external account. Currency codes are format-validated identifiers;
W0 does not connect to a currency registry.

## Initiative decisions and execution

Stored states are `DISCOVERED`, `PROPOSED`, `APPROVED`, `CANCELLED`, and `REVIEWED`.
Only people approve, cancel or review. Review closes an approved initiative with
`KEEP`, `REVERT`, `EXTEND`, or `INCONCLUSIVE`, plus a reason. Replay identities
include the conclusion; stale revisions and conflicting replays are refused.

Delivery and measurement do not change those states. W0 derives `NOT_STARTED`
or `EXECUTED` and `executionCount` from current linked intervention rows. This
means that an execution was recorded, not that a website was published or an
outcome measured. W2/W3 may later derive finer adapter and measurement progress
from their authoritative records. The primary page is optional.

Rationale evidence remains `OBSERVED`, `OPERATOR_HYPOTHESIS` or
`MODEL_SUGGESTION`. Execution and outcomes are not rationale evidence types.
Existing validation of real, same-business observed references is preserved.

## Execution-ledger contract

Migration 0030 adds nullable columns to `interventions` and the append-only
`growth_initiative_actions` link table. An approved initiative can have multiple
interventions across `WEBSITE`, `THIRD_PARTY_PROFILE`, `EMAIL`, `PAID`, `SOCIAL`,
and `OTHER`. New types include `CAMPAIGN_SENT` and `LISTING_UPDATED`.

Legacy intervention rows keep null assurance and existing protocol semantics.
The new columns are not exported in protocol v1 packets.

- `OPERATOR_ATTESTED` requires a HUMAN actor whose ID is a member of the business
  account. It cannot contain system-verification fields. Deployment assertions
  must be labelled `DEPLOYMENT_ATTESTED` by the later adapter.
- `SYSTEM_VERIFIED` currently describes only `GROWTH_DELIVERY` / `PR_MERGED`, on a
  WEBSITE / SOURCE_UPDATED row with SYSTEM actor. It proves a repository merge,
  not production publication.
- `growth_execution_verified(execution interventions)` receives the entire row.
  W0 returns false for all claims. W2 must resolve the exact business, event,
  before/after digests and performed time against its confirmed adapter record.
  Merely possessing a delivery ID is insufficient.

Links check tenant, approval, actor identity and proof. Corrections cannot move
an action to another initiative. Historical rows, links, evidence and decisions
remain append-only; corrections use the existing supersession model.

W0 provides this schema/type contract and derived reads. Attestation routes/UI,
GitHub delivery integration and measurement imports remain separate workstreams.

## API, tools and UI

Existing registration, profile, proposal and decision routes use the new
contract. `POST /api/growth/clients/:id/opportunities/:opportunityId/review` is
operator-only, session/origin scoped and revision/idempotency guarded.

The operator agent retains scoped read/propose capabilities only. It receives
the new metric definition through the existing goal read tool. No approve,
attest, import or review tool is added. `GrowthRepositoriesLive` centralizes the
growth layer used by API callers for subsequent workstreams.

The existing onboarding/profile form supports the four categories and both
sources, shows explicit unit/currency/timezone fields, and separates the goal
statement. The workspace shows recorded execution counts separately from human
decision state, offers human review, and accepts initiatives without a page.
No browser verification is claimed in this phase.

## Migration safety

Only 0030 changes. 0031 remains owned by P2/W2; 0032 is reserved for measurement.
No existing P1/P2 database is reset or upgraded by W0.

The amended migration accepts fresh databases, pre-0030 populated databases,
and populated databases already on W0. An older `growth_goals.kind` layout is
explicitly refused before W0 schema writes. `CREATE TABLE IF NOT EXISTS` is not
an upgrade strategy for old 0030/0031 databases. Those databases must remain on
the preserved code until an explicit data-preserving forward conversion is
commissioned, or a new database is selected. W0 does not claim such a conversion.

The repeatable rehearsal creates only new databases in an owned loopback
fixture container and never drops or resets an existing database:

```sh
python3 scripts/verify-marketing-w0-migrations.py \
  --container openrecord-marketing-w0-20261019 \
  --output /absolute/new/private/output-directory
```

It checks fresh/replay, populated pre-0030 upgrade/replay, raw evidence and
legacy intervention preservation, schema-catalog equivalence, and preservation
when an old 0030 layout is refused. Use Node 24 and pnpm on PATH.

## P2 integration requirements

Preserve P2 at `ee80b911be5b60b9fcfa218f365e586a85929823`. In a later W2 phase:

1. Rebase/adapt against verified W0 without rewriting the preserved branch.
2. Retain targets, patch/base binding, path guards, claims, reconciliation and
   review controls. Remove `moveOpportunity`, the opportunity-event delivery
   column/guard rewrite, and VERIFIED_ACTION rationale writes.
3. Replace the full-row verifier with exact merged-delivery validation.
4. In the merge transaction append a SYSTEM_VERIFIED PR_MERGED intervention and
   initiative link. Use GitHub's confirmed merge time and bound content digests.
5. Rename DEPLOYMENT_VERIFIED to DEPLOYMENT_ATTESTED; append a separate HUMAN /
   OPERATOR_ATTESTED SOURCE_PUBLISHED row and link. Do not imply independent
   deployment verification.
6. Allow multiple deliveries while the initiative remains APPROVED. Adapt
   contracts, fixtures, UI and tests to the new decision and metric documents.

W0 must be incorporated into #65 before #65 is considered for a main merge.
Do not merge the old P1 schema first and rely on W0 to reshape it afterward.
