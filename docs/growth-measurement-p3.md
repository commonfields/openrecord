# Marketing control-plane W3 contract

W3 adds measurement imports, a resolved daily series, and pre-declared
measurement plans. It is coverage and bookkeeping only: no impact, lift or
attribution is ever inferred. Business and Record profiles remain the identity
and tenant boundary, and every W0 invariant (append-only growth records,
operator-only decisions, replay identities) is preserved untouched.

## Metric imports

Daily aggregates enter through one route per metric definition:
`POST /clients/:businessId/growth/measurement/metrics/:metricId/imports`.
The body carries the raw file bytes (base64), the file name, the declared date
range, and the declared provenance (`REAL`, `SYNTHETIC`, or `MISSING`).

The raw bytes are stored verbatim with their SHA-256 digest, the source
identity, the declared reporting timezone and the provenance. Imports are
append-only: a replay with the same bytes for the same business is an
idempotent no-op that returns the original import; different bytes for the same
definition and range are refused as a conflict.

Parsing is strict and fail-closed:

- GA4 aggregate exports are parsed with the W0 `parseGa4Export` rules. Key
  events are aggregated per day across source/medium rows; the per-row
  source/medium detail is never stored.
- Operator exports are single-row-per-day CSVs with a value column; duplicate
  days are refused.
- Every row stores the day, the value, and the provenance copied from the
  import. Values must be non-negative integers inside the declared range;
  dates outside the declared range, malformed dates, unknown columns, missing
  conversion columns and negative values are refused before anything is
  written.
- A single import carries exactly one metric definition. Cross-format payloads
  (GA4 shape for an operator metric or vice versa) are refused.

`SUM` / `CURRENCY_MINOR` definitions are accepted as metric definitions (W0
capability) but every attempt to import or plan against them is refused:
currency aggregation is not implemented, no exchange rate is ever inferred,
and no revenue total is ever stored. The refusal is enforced both in the
repository and in the database guard, so direct SQL writes fail closed too.

## Resolved series

`GET .../metrics/:metricId/series?start&end` resolves one value per day over
at most 400 days. Resolution rules, in priority order:

1. A day outside every import's declared range is `UNAVAILABLE`.
2. A day covered by at least one import but reported by none is `MISSING`:
   coverage was declared, no row carried a value.
3. Otherwise the newest import that **reports** a row for the day supplies the
   value and its provenance. A later small corrective upload that does not
   report a day therefore cannot erase that day's value.
4. If two or more reporting imports disagree on the day's value, the day is
   `CONFLICT`: the newest reported value wins, and all disagreeing values stay
   visible in `conflicts` with ascending, deterministic ordering.

Provenance is preserved per day from the winning row. A synthetic or missing
provenance never silently upgrades to real; the series response carries each
day's provenance next to its value.

## Measurement plans

`POST .../opportunities/:opportunityId/measurement-plan` declares, before any
linked execution exists, the baseline window and the observation window the
operator intends to read. The plan is immutable and append-only. Declaring is
refused unless the opportunity is `APPROVED`, the metric is count-based, and
the windows are valid (baseline ends before observation starts, both inside
the supported range, no overlap).

Plan timing is evaluated against linked attested executions, never mutated
after the fact:

- `PRE_DECLARED` — no linked execution exists yet, or the earliest linked
  execution happened after the plan was declared.
- `DECLARED_AFTER_EXECUTION` — a linked execution's `performed_at` predates
  the plan's `declared_at`. The plan is still stored (append-only), but the
  response marks it, so a plan can never retroactively claim it preceded the
  change it measures.

`GET .../measurement-plan` returns the latest plan by `declared_at` for the
opportunity. There is one active plan per opportunity; re-declaration after an
execution is allowed and is exactly what produces
`DECLARED_AFTER_EXECUTION` rather than a silent overwrite.

## Refusals

All refusals are explicit typed reasons carried by `GrowthMeasurementRefused`;
nothing is inferred or auto-corrected. The API maps parse/validation reasons
to `422`, `*NotFound` to `404`, and everything else (conflicts, drift,
fail-closed currency) to `409`.

| Reason | HTTP | Trigger |
| --- | --- | --- |
| `InvalidRequest` | 422 | Malformed UUIDs, dates or payloads |
| `InvalidDateRange` | 422 | `start > end` or inverted windows |
| `InvalidPlanWindow` | 422 | Plan windows overlapping or out of order |
| `InvalidSeriesRange` / `SeriesRangeTooLarge` | 422 | Series request malformed or over 400 days |
| `ExportSize` / `TooManyRows` / `MissingHeader` / `MissingColumn` | 422 | Upload shape rejected before parsing |
| `UnexpectedColumn` / `MalformedRow` | 422 | Unknown columns or unparseable rows |
| `InvalidDate` / `DateOutsideRange` | 422 | Row date malformed or outside the declared range |
| `DuplicateRow` | 422 | Duplicate day in an operator export |
| `InvalidValue` / `ValueTooLarge` | 422 | Negative, non-integer or out-of-range values |
| `ConversionColumnMissing` | 422 | GA4 export without the required key-event column |
| `MetricDefinitionNotFound` / `OpportunityNotFound` / `GrowthNotFound` | 404 | Foreign or unknown scope |
| `IdempotencyConflict` | 409 | Different bytes for the same definition and range, or a replayed plan key with a different body |
| `CurrencyMeasurementRefused` | 409 | Import or plan against a `SUM`/`CURRENCY_MINOR` metric |
| `ImportSourceKindMismatch` / `ImportTimezoneMismatch` / `ImportPropertyRefMismatch` / `ImportRowOutsideRange` | 409 | Payload drifts from the stored metric definition |
| `PlanMetricMismatch` | 409 | Plan references a different metric than the opportunity's goal |
| `PlanOpportunityNotApproved` | 409 | Plan declared on a non-`APPROVED` opportunity |

The same rules are enforced twice: in the repository (typed refusals) and in
PostgreSQL triggers (`guard_growth_metric_import`, `guard_growth_metric_row`,
`guard_growth_plan`), so a bypass of the application layer still fails closed.

## Migration numbering

`0032_growth_measurement_v1.sql` is the only W3 migration. It creates
`growth_metric_imports`, `growth_metric_rows`, `growth_measurement_plans`,
their append-only triggers and guards, and the `growth_metric_import_documents`
and `growth_measurement_plan_documents` views. It runs after the landed 0030
and never depends on the preserved 0031 delivery objects: a database that
ingested the preserved old 0031 is refused at the top of 0032 before any W3
object is created. The preserved 0030/0031 files are never replayed; the
rehearsal script `scripts/verify-marketing-w3-migrations.py` proves fresh and
replayed installs, a populated compatible upgrade, legacy-row preservation, and
all refusal paths.

## Non-goals

No revenue aggregation, FX conversion, attribution, lift estimation, anomaly
detection, alerting, scheduled ingestion, or authenticated analytics-provider
access. No editing or deletion of imported rows. No plan outcomes: W3 stores
what was declared and when executions happened; reading impact out of the
series is operator work.
