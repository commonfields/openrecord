# Marketing control-plane W5 contract: client outcome reports

W5 turns one W4 outcome evaluation into a report an operator can hand to a
client. A report answers seven questions:

1. What business outcome was targeted?
2. What initiative was approved?
3. What was actually recorded?
4. How strongly is each action proven?
5. What did the measure show?
6. What limits that reading?
7. What did a person decide next?

It is a communication product, not an analytics engine. W4
(`evaluateGrowthOutcome`) stays the only outcome evaluator. Its result is
embedded verbatim and nothing is recomputed.

## Reused infrastructure

| Need | Reused from |
| --- | --- |
| Goal, metric definition and version, initiative, human decisions | W0 (`GrowthRepository.get`, `growth_goal_documents`) |
| Recorded actions and assurance | W1 ledger through the W4 evaluation (`actions`) |
| Plan, imports and digests | W3 (`growth_measurement_plans`, `growth_metric_imports`) |
| Outcome, data-quality status, reasons and caveats | W4 `GrowthEvaluationRepository.evaluate` |
| Share capability, revocation, no-store and noindex headers, public page shell | Client record sharing (`record_shares`, `/open/:publicId`) |
| Append-only guard | `prevent_append_only_mutation` (0003) |

No model or agent is involved. The Operator Agent gets no report tool.

## Snapshot integrity

**Assembly.** `GrowthReportRepository` assembles every input inside one
`REPEATABLE READ` transaction, so all reads see one database snapshot. The
inputs are:

- the W4 evaluation, which itself reads the plan, both daily series and the
  ledger;
- the initiative and its latest human review;
- the business identity;
- the digests of the imports that cover the plan.

`generatedAt` is the transaction clock.

**Preview, then publish.** The operator first previews
(`GET …/report-preview`). The preview returns the snapshot, an
`evidenceDigest` and the latest version number. The evidence digest is a
SHA-256 over the canonical snapshot, ignoring only `generatedAt`,
`publication`, `nextSteps` and the evaluation clock.

Publishing (`POST …/reports`) repeats the assembly in a fresh consistent
snapshot. It is refused with:

- `ReportEvidenceChanged` when the evidence digest differs from the one the
  operator reviewed;
- `StaleReport` when the latest version is no longer `expectedLatestVersion`;
- `ReportInitiativeNotApproved` when the initiative has no approval.

A `COMPARABLE` status never publishes anything by itself.

**What is stored** (`0033_growth_reports_v1.sql`). The snapshot is stored as
canonical JSON text: keys sorted at every depth, no whitespace. It includes:

- `publication = { version, publishedAt, supersedesReportId }`;
- the operator's optional, human-written `nextSteps`;
- the exact W4 evaluation;
- import ids and digests (never raw CSV);
- the human review (`conclusion`, `reason`, `decidedAt`), or null.

A review is never invented. Only an `OPERATOR` `REVIEWED` event fills it.

**Database guards.** The `growth_reports` guard refuses any insert whose:

- `snapshot_digest` is not `sha256(snapshot_text)`;
- JSON identity (schema, business, initiative, evaluation status, version,
  supersedes, published time) differs from the row;
- `published_at` is not the transaction's own clock;
- initiative has no human approval;
- version does not continue the linear chain. Each version must supersede
  exactly the previous one.

Updates, deletes and truncates are refused.

**Corrections.** A later import never touches a published version. A
correction is a new version that supersedes the old one, and old versions stay
readable and are marked superseded.

**Idempotency.**
- A request key is unique per business and stores a fingerprint of
  `{opportunityId, expectedLatestVersion, evidenceDigest, nextSteps}`.
- Replays return the original report with `replayed: true`. A different body
  under the same key is refused with `IdempotencyConflict`.
- Concurrent publications that collide on the key or the version are retried
  on a fresh snapshot (up to twice). The retry then replays the committed
  report or reports `StaleReport`.

**Correction chains.** Before W5, the W4 evaluation showed a correction to a
linked execution as an unrelated entry, and W3 plan timing ignored
corrections. Both now follow `growth_intervention_chain_root`, so a correction
is reported as part of its initiative and cannot hide an earlier action from
the plan-timing check.

## Routes

**Operator routes.** All require an operator session and the same origin, and
all respond with `cache-control: no-store`. Responses:

- `401` without a session;
- `404` for another account's business or report (nothing is echoed);
- `422` for malformed ids or input;
- `409` for the refusals above.

| Method and path | Purpose |
| --- | --- |
| `GET /api/growth/clients/:id/opportunities/:opportunityId/report-preview` | Unsaved snapshot, `evidenceDigest`, `latestVersion` |
| `POST /api/growth/clients/:id/opportunities/:opportunityId/reports` | Publish `{ idempotencyKey, expectedLatestVersion, evidenceDigest, nextSteps }` → `{ report, replayed }` |
| `GET /api/growth/clients/:id/opportunities/:opportunityId/reports` | Versions, newest first, with superseded and share state |
| `GET /api/growth/clients/:id/reports/:reportId` | One version with its full snapshot |
| `POST /api/growth/clients/:id/reports/:reportId/share` | Create (or return the active) view-only link |
| `POST /api/growth/clients/:id/reports/:reportId/share/revoke` | Revoke the active link |

**Public route.** `GET /api/public/growth-reports/:publicId` takes only the
capability. It responds with `no-store`, `x-robots-tag: noindex, nofollow` and
`referrer-policy: no-referrer`. Unknown, malformed and revoked links return
byte-identical `404`s.

The web page for a link is `/reports/:publicId`. It sits outside the
workspace shell, carries noindex and no-referrer meta tags, and has a
print/save-as-PDF button.

## Share access and revocation

- **Link format.** One `growth_report_shares` row per link. The link id is 32
  random bytes in base64url (256 bits), the same as `record_shares`.
- **Scope.** At most one active link per report version. A link opens exactly
  that frozen version, and still opens it after a newer version exists, with a
  "newer version published" notice.
- **Revocation.**
  - Allowed only from ACTIVE to REVOKED, once.
  - Must be done by an account user, at server time.
  - The row is never deleted.
  - A new link has a new id, and a revoked id never works again.
- **Public projection** (`publicGrowthReport`).
  - Drops user and account ids, approval and other decision reasons, execution
    descriptions (internal notes), opportunity assumptions and hypotheses, raw
    files and other businesses.
  - Identifiers and digests appear only in the evidence section.

## Client presentation

`GrowthReportView` (the operator preview and the public page share it) has
these sections:

- business and reporting period;
- what we set out to improve;
- the approved work;
- what was done, with each action's proof level and other activity in the
  same period;
- what we measured: data quality, plain-language reasons, before/after table
  and the descriptive comparison;
- what limits this result;
- decision and next steps;
- evidence and provenance.

Ordinary prose never shows UUIDs, internal codes or SQL terms. Every
comparison carries "This describes what was recorded. It does not show that
the work caused the change." "Can be compared" is stated as data quality,
never success. The evaluator's verbatim limitations and each finding's code
and detail stay in the evidence section.

## Verification

- `packages/contracts/src/growth-report.test.ts`: canonical digest,
  evidence-view invariance, public projection, input refusals.
- `apps/api/src/growth-report.integration.test.ts`: both acceptance workflows
  and every negative scenario (missing, conflicting, synthetic-only data, late
  plan, unrelated actions, attestation only, zero baseline, a new import after
  publication, revoked token, cross-account access, repeated and concurrent
  publication, database guards).
- `apps/api/src/growth-evaluation.integration.test.ts`: the correction-chain
  regression.
- `apps/web/tests/growth-report.test.ts`: plain-language rendering with no ids
  or codes in prose, routes and card gating.
- `scripts/verify-marketing-w5-migrations.py --admin-url … [--populated-db …]`:
  loopback-only rehearsal in new databases. It checks fresh install and
  replay, populated upgrade and replay with preserved legacy rows, catalog
  equality, byte-identical report rows after replay, and refusal of the old
  0031 marker by `migrate()` and by 0033 alone. No database is reset.

## Non-goals

No attribution, lift, ROI, success scoring, scheduled or automatic
publication, email delivery, PDF rendering service, W2 adapters, MCP, campaign
generation or channel execution.
