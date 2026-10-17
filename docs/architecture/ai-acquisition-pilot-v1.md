# AI Acquisition Pilot V1 — architecture

Buyer: an agency or growth team that wants more customers from AI assistants.
Customer job: **show when an AI assistant recommends a business, what sources it cites, and whether AI referrals produce measurable business activity.**

Record Integrity asks whether an AI answer agrees with an approved fact. AI Acquisition asks whether a measured AI surface
mentions or recommends a business when a buyer asks for a product or service. The two loops share evidence and nothing else.

## Five separate events

| Event | Source | Stored as | Confirmed by |
|---|---|---|---|
| 1. Brand appeared in an answer | answer sample | derived candidate (exact alias match) | human review (`acq_judgments.mention`) |
| 2. Assistant recommended the brand | answer sample | — | human review (`acq_judgments.recommendation`) |
| 3. Assistant cited the brand's website | answer sample citations | derived (`classifyCitation`) | owned-domain allowlist, provider-reported domain |
| 4. A user arrived from an AI assistant | GA4 export | `acq_referral_rows` | the export, as GA4 attributed it |
| 5. The visitor converted | GA4 export | `acq_referral_rows.conversions` | only when a conversion event is stated, else `SIGNUPS_NOT_MEASURED` |

They are never combined into a score. Referral data is never inferred from answer sampling, and a mention is never read as a sale.

## Data model (migration 0026)

| Concept | Implementation |
|---|---|
| Versioned question set + brand configuration | `acq_question_sets`: basis (`AUTHORIZED_CLIENT` / `PUBLIC_RESEARCH` / `FIXTURE`), category, target brand, aliases, match-case flag, ambiguity note, owned domains, competitors, `spec_digest` (sha256 of the canonical spec). Write-once. |
| Frozen buyer question | `acq_questions` (key `CD-01`…, intent group, position) → a dedicated `buyer_questions` row holding the exact prompt. Insertable only in the transaction that created the set; the prompt row becomes immutable (`guard_acq_buyer_question`). |
| Measurement batch | `acq_batches`: set, scope (`SMOKE` / `FULL`), samples per question (1–5), provider, model, requested retrieval, `max_provider_calls` acknowledged by the operator. |
| Observation reference | `check_runs.acq_batch_id / acq_question_id / acq_sample`. The existing worker executes these ordinary checks unchanged; observations, raw evidence, citations, failures and retrieval metadata are the existing rows. Nothing is copied. |
| Candidate brand mention | Derived on read (`detectMentions`, `acq-exact-alias-v1`). |
| Human recommendation judgment | `acq_judgments`: mention, recommendation (required exactly when mentioned), detector version and target-candidate count the server re-derived at review time, note, reviewer = session account member at server time, append-only correction chain. |
| Acquisition evidence report | Derived on read (`acquisitionReport`). |
| Referral evidence | `acq_referral_imports` (stated property, range, time zone, attribution basis, conversion event, original text, sha256, data origin) + `acq_referral_rows`. |

Every table is account-scoped through composite `(id, business_id)` foreign keys, guarded by `record_member` triggers, and
append-only (no UPDATE / DELETE / TRUNCATE). Check identity (batch, question, sample, provider, model) is immutable. The migration
is replay-safe: `migrate()` re-runs it on every start.

`MATCHES` / `CONTRADICTS`, record slots and the three-fact record limit are untouched (architecture test).

## Detection (`packages/db/src/acquisition-detect.ts`)

Deterministic and auditable. An alias matches only between Unicode word boundaries, case-insensitively unless the brand is
configured to match case. Overlaps resolve to the longest span; an identical span claimed by two brands is flagged as a collision
(set creation also refuses shared aliases and shared domains). Each candidate carries the sentence and reviewer hints:
`NEGATIVE_CUE`, `LIST`, `COMPARISON`. Hints are never verdicts. There is no automatic or LLM judge, and Jev is not in this path.

## Citations

Gemini grounding cites `vertexaisearch.cloud.google.com/grounding-api-redirect/…` URLs and reports the source domain only as the
chunk title. The domain is taken from the URI host for ordinary links and from the provider title for grounding redirects
(`domainBasis: PROVIDER_TITLE`). Redirects are never followed. Owned and competitor matching is exact host or subdomain of a verified
domain, never a lookalike. Citation support is always `NOT_VERIFIED` in V1: cited pages are not fetched. The provider's own
"linked to answer text" flag is shown as provider-reported.

## Measurement contract (`packages/db/src/acquisition-view.ts`)

- **Eligible sample**: a `SUCCEEDED` check with a non-synthetic observation. Failed checks stay in planned and attempt counts.
- **Mention rate**: confirmed `MENTIONED` reviews / eligible samples. Unreviewed candidates are shown separately and never counted.
- **Recommendation rate**: reviewed `RECOMMENDED` / reviewed eligible samples.
- **Owned-domain citation rate**: eligible samples citing an owned domain / eligible samples.
- **Competitor appearances**: eligible samples with an exact-name detection per named competitor. Not reviewed; not market share.
- **Repeatability**: per frozen question, "Recommended in r of n reviewed samples" with unreviewed and failed samples named.
  Never a probability. Samples of one question are correlated, so no interval is computed from sample counts; question-level
  counts are reported alongside.
- **Periods**: each batch is reported on its own. Configuration differences (set version, provider/model, retrieval, samples,
  questions) are listed and nothing is subtracted, so no improvement claim exists to make.

## Provider execution

Reused unchanged: authenticated API, account isolation, worker queue, explicit provider/model (the record surface:
`RECORD_PROVIDER` + `GEMINI_MODEL`), bounded retries (4 attempts), immutable raw evidence with digest, citations, timestamps,
provider failure records, retrieval requested vs observed. A batch queues checks with increasing `queued_at`, so the worker asks
in frozen question order. Starting a batch requires `acknowledgedMaxProviderCalls = planned checks × 4`; the fixture provider and
synthetic referral data work only in tests and explicit local demos.

Measurements describe the configured Gemini surface only. They do not measure ChatGPT, Claude or any other assistant, and the
report says so.

## Sharing

V1 delivers an authenticated operator report (`/clients/:id/discovery/report`, print or save as PDF). There is no public
acquisition route and no share projection: Record Integrity's share guarantees cover its own allowlist, and extending them to
acquisition findings would need a reviewed-only public projection of its own. Unreviewed findings are never published.

## Not built

GA4 or Search Console OAuth, a browser tracker, an attribution SDK, multiple provider adapters, a model router, automatic
judgments, Jev integration, rank tracking, keyword volumes, content generation, visibility scores, billing, a CRM.
