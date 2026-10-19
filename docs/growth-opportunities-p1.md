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

W0 decision (F8): `SUM` / `CURRENCY_MINOR` remains an explicit metric
definition capability, not an implemented revenue path. W0 performs no revenue
ingestion, aggregation, attribution or currency conversion, and no exchange rate
is ever inferred. Those operations belong to W3, which must implement strict
import validation and aggregation before any currency-sum measurement exists;
until then every currency-sum measurement path must fail closed as unsupported.
A stored definition never creates a measurement.

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

W0 decision (F5): `C3 = STORED PASS / DERIVED PARTIAL`. Stored human decision
state, revision history, review conclusions and replay guards are complete and
authoritative. The derived progress view intentionally stays two-state
(`NOT_STARTED` / `EXECUTED`) in W0 and adds no unreachable delivery or
measurement states. A richer progress projection is assigned to the phases that
implement actual execution and measurement (W2 delivery reconciliation, W3
measurement). This is an explicit acceptance decision, not an unreported gap.

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

Links check tenant, approval, actor identity and proof. One initiative owns an
entire intervention correction chain: the link guard resolves the chain root,
locks it, then refuses when any member of the chain is already bound to a
different initiative. The rule is independent of link order (original first or
correction first), holds across multiple corrections, and serializes concurrent
links on the same chain. Historical rows, links, evidence and decisions remain
append-only; corrections use the existing supersession model.

Profile updates are identified requests. `PUT /api/growth/clients/:id` carries
an `idempotencyKey`. Migration 0030 stores the request key, a SHA-256 fingerprint
of the exact normalized content, and the original result document in an
append-only table, read only after the business row lock. An identical replay
returns the original document without re-applying anything; the same key with
different content is refused; a replay after a newer update returns its original
document while the newer stored profile remains current. Goal and metric history
is never rewritten by a replay.

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

The amended 0030 reuses the existing `uq_record_tenant_interventions` unique
index from 0022 for the interventions composite foreign key instead of adding a
duplicate tenant-uniqueness constraint. The `(id, business_id)` unique
constraints on growth metrics, goals and opportunities remain because their
composite foreign keys require them; they are not redundant.

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
3. Replace the full-row verifier with exact merged-delivery validation, as
   required by item 10 below.
4. In the merge transaction append a SYSTEM_VERIFIED PR_MERGED intervention and
   initiative link. Use GitHub's confirmed merge time and bound content digests.
5. Rename DEPLOYMENT_VERIFIED to DEPLOYMENT_ATTESTED; append a separate HUMAN /
   OPERATOR_ATTESTED SOURCE_PUBLISHED row and link. Do not imply independent
   deployment verification.
6. Allow multiple deliveries while the initiative remains APPROVED. Adapt
   contracts, fixtures, UI and tests to the new decision and metric documents.
7. (F2) Close the review/merge race. No final initiative review may complete
   while a preauthorized or in-flight GitHub delivery is unresolved; use the
   authoritative delivery state and the same locking boundary. If the remote PR
   merged while reconciliation is incomplete, operators must still be able to
   record a confirmed review result, and later reconciliation must not silently
   rewrite it. Add concurrent review/merge tests.
8. (F6) Expose the proof level before any execution status. Operator-attested
   execution must never look system-verified in API, agent or UI output; each
   surface labels the assurance and the exact claim.
9. (F7) Do not replay the preserved old 0031 over W0's 0030. Ship a separately
   adapted W2 migration with a lineage preflight that refuses old or mixed
   layouts, plus compatibility tests for fresh and upgraded databases. Preserve
   the W0 views, guards and contracts.
10. (F10) Replace `growth_execution_verified(interventions)` in place; do not
    add a competing three-argument overload with different semantics. The
    replacement binds business, delivery identity, event, claim, before/after
    content digests and GitHub's recorded merge time. A merge is PR_MERGED
    evidence, never publication proof.

W0 must be incorporated into #65 before #65 is considered for a main merge.
Do not merge the old P1 schema first and rely on W0 to reshape it afterward.
