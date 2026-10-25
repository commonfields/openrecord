# Marketing control-plane W1: operator-attested execution

W1 records what a person actually did for an approved growth initiative. It adds
no persistence: it reuses W0's `interventions` ledger and the append-only
`growth_initiative_actions` link table from migration 0030. There is no W1
migration, so W2's reserved 0031 and W3's 0032 remain untouched.

## API

`POST /api/growth/clients/:id/opportunities/:opportunityId/executions` is
operator-only, session- and origin-scoped like the other growth routes. The
request is:

| Field | Meaning |
| --- | --- |
| `type` | The action actually performed: `SOURCE_UPDATED`, `SOURCE_PUBLISHED`, `THIRD_PARTY_CORRECTION_REQUESTED`, `KNOWLEDGE_BASE_UPDATED`, `STRUCTURED_DATA_UPDATED`, `CAMPAIGN_SENT`, `LISTING_UPDATED` or `OTHER` |
| `channel` | `WEBSITE`, `THIRD_PARTY_PROFILE`, `EMAIL`, `PAID`, `SOCIAL` or `OTHER` |
| `target` | What the action touched: page, listing, campaign, profile or artifact reference. Plain text or an absolute, credential-free http(s) URL. |
| `description` | What was actually done, in the operator's words |
| `performedAt` | Strict RFC 3339 instant with seconds and an explicit offset; impossible calendar dates, day-only values and offset-less values are refused at the boundary |
| `idempotencyKey` | Request identity for safe retries |

The request has no assurance, actor, verification or tenancy field. Excess
properties are refused with 422, so neither a client nor an agent can claim
`SYSTEM_VERIFIED` or a different author. The repository always writes
`actor='HUMAN'`, `actor_id` = the session operator and
`assurance='OPERATOR_ATTESTED'` with null verification columns. A future
adapter is the only writer of `SYSTEM_VERIFIED`, and it must satisfy the exact
claim named in the W0 contract (`GROWTH_DELIVERY` / `PR_MERGED` on a WEBSITE
`SOURCE_UPDATED` row).

A reference that looks like a URI must use `http:` or `https:` and must not
embed credentials. OpenRecord stores the reference and never fetches it to
accept an attestation. This is deliberately not proof of publication.

### Channel/type compatibility

W0 keeps channel as a property of *what was done where*, not of the initiative.
Only the types whose name already fixes the venue are constrained; generic
source and knowledge actions remain valid on every channel, and `OTHER` is the
escape hatch. This preserves software, service, commerce and agency use cases.

| Type | Allowed channels |
| --- | --- |
| `CAMPAIGN_SENT` | `EMAIL`, `PAID`, `SOCIAL`, `OTHER` |
| `LISTING_UPDATED` | `WEBSITE`, `THIRD_PARTY_PROFILE`, `SOCIAL`, `OTHER` |
| `THIRD_PARTY_CORRECTION_REQUESTED` | `THIRD_PARTY_PROFILE`, `SOCIAL`, `OTHER` |
| all other types | every declared channel |

Recording requires the initiative to be `APPROVED` at link time, which the
database guard enforces. The repository checks the current status while holding
the opportunity row lock and refuses with 409 (`InitiativeNotApproved`)
otherwise. The performed time is an assertion about the past: a value more than
five minutes after the database clock is refused with 422
(`ExecutionTimeRefused`).

## Idempotency and concurrency

The opportunity row is locked before the request identity is read. Two
concurrent identical recordings therefore observe the first committed row: one
ledger entry and one link exist, and the replay returns the original document.
The same key with different content is refused (`IdempotencyConflict`, 409).
The identity is also bound to the authenticated author: another member of the
same account cannot reuse the key to present the first operator's row as their
own. A replay after the initiative was reviewed or cancelled still returns its
original record; it never appends another entry or re-links an existing one.
Independent keys serialize on the same lock and append separate executions, so
an approved initiative can accumulate many channel-neutral actions. W0's
correction-chain rule still binds an entire chain to one initiative.

Boundary whitespace in `target` and `description` is normalised, so a retry with
formatting whitespace is still a replay rather than a conflict. The entire
write — intervention and link — runs in one transaction. A forced link failure
is covered by a test that verifies no orphaned intervention remains and that a
later retry succeeds once.

## Reads

`GET /api/growth/clients/:id/opportunities` and `.../:opportunityId` expose
`executions` inside each opportunity document, oldest first, each with its exact
assurance: `OPERATOR_ATTESTED` with the operator's `actorId`, or
`SYSTEM_VERIFIED` with the adapter claim. There is no separate executions GET;
the existing scoped opportunity read/list is the read model, so history cannot
be fetched without the same tenancy check. Superseded corrections are excluded,
matching `executionCount` and the derived `progress` (`NOT_STARTED` /
`EXECUTED`): `executions.length === executionCount`.

## Workspace

The existing growth workspace's approved-initiative card adds a Record
execution dialog and an Execution history section. The dialog offers only
channels compatible with the chosen action. The history shows:

- the channel and action type;
- the reference the operator supplied;
- what the operator says happened;
- who asserted it, when they asserted it, and when they say it happened;
- an assurance badge and sentence: **Operator-attested**, or the exact system
  claim. A merge is never presented as production publication.

The Operator Agent keeps its scoped read/propose tools. It has no attestation
tool and cannot author a human record.

## Not in W1

No GitHub adapter, external platform integration, measurement import, causal
attribution, correction UI, deployment verification or assistant attestation
tool. Agents keep scoped read/propose capabilities; only people attest. W0's
decision that legacy intervention rows keep null assurance and stay out of
protocol v1 packets is unchanged.

## Tests

Contract decoding: every compatible and incompatible action/channel pair, strict
timestamps (offset, impossible dates, `24:00`, leap years), reference schemes,
every declared action, and refusal of assurance/actor/verification/tenancy
fields. Repository: software (`SOURCE_PUBLISHED` / `WEBSITE`) and
service/commerce (`LISTING_UPDATED` / `THIRD_PARTY_PROFILE`) actions, multiple
actions per initiative, replay, actor-bound conflict, whitespace replay,
concurrent replay, future-time refusal, cross-tenant refusal, append-only
enforcement, and transaction rollback on a forced link failure. HTTP: auth,
origin, scoped 404s, invalid payloads, forged authority, duplicate concurrent
submissions, list/detail history, replay after review, and assurance labels.
Workspace: dialog validation, compatible-channel filtering, history rendering,
actor labels and distinct attestation/verification labels. All fixtures are
labelled `TEST`.
