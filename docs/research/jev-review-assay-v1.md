# Jev shadow assay v1: protocol, offline harness, and readiness

```text
VERDICT            = JEV_ASSAY_BLOCKED_REFERENCE_LABELS   (primary)
ALSO BLOCKED BY    = JEV_ASSAY_BLOCKED_AUTHORIZATION
LIVE_EXECUTION     = NOT_EXECUTED   (0 provider requests, USD 0 spent)
GENUINE LABELS     = 15 human MATCHES, 0 CONTRADICTS, 0 UNKNOWN (3 facts, 1 business)
CITATION CONTENT   = 0 citations with preserved source text
RECOMMENDATION     = DEFER (no production integration)
```

Offline performance numbers come from synthetic constructed cases or
authored fixture responses. Reference-label counts come from the private G2
closeout and a read-only current-head query on 2026-10-18. A frozen reference
corpus and provenance audit remain missing. None of these
numbers measures live Jev accuracy. The research package is
[`research/jev-review-assay`](../../research/jev-review-assay/README.md).

## 1. Question and boundary

Can Jev act as an optional, narrow classifier that helps a human reviewer, for
two tasks:

- **Task A, factual contradiction assistance.** Given a frozen fact, the
  original question asked to the AI, the exact AI answer, and relevant source
  evidence, return a candidate `SUPPORTS`, `CONTRADICTS`, `NOT_ADDRESSED`, or
  `AMBIGUOUS`.
- **Task B, citation support assistance.** Given an AI claim, its citation, and
  the preserved cited source text, return `SUPPORTS`, `CONTRADICTS`, or
  `DOES_NOT_ADDRESS`. A URL is not source content. Without preserved text the
  item abstains before any model call.

Jev does not update facts or write human judgments. It does not change
acquisition recommendations or publish records. It does not trigger
measurements or modify websites, and it does not run as a production
classifier. Nothing under `apps/`, `packages/`, the worker, acquisition
classification, or the conversation runtime imports this package. A test
enforces this. The SDK dependency lives only in the package's own lockfile,
outside the pnpm workspace, and root lint, typecheck, and test never load it.

## 2. Reuse of the historical research (PR #5)

| Element | Historical (`research/jev-assay`, `src/jev_assay.rs`) | This assay |
|---|---|---|
| Evaluation protocol | Preregistered, frozen question set and thresholds, holdout exposure counter | Reused in principle. New protocol id `openrecord-jev-shadow-protocol-v1` because the contract changed. |
| Input/output contract | 3–4 Noul yes/no questions composed into labels by fixed thresholds | Replaced by one SDK `choice` question per task. SDK 0.7.0 returns `{choice, confidence, probabilities}`, so a probability vector is available directly. |
| Budget enforcement | `--max-requests`, `INSUFFICIENT_REQUEST_BUDGET` before any request, no partial benchmarks | Ported (`RequestBudget`). One request per eligible item, checked before each request. |
| Receipt format | `receipt-schema-v1` JSONL | Extended. Receipts add input and question digests, split, business id, fact id, material, requested and observed model, usage source, cost basis, and a safe error class. |
| Model identity pinning | `GET /v1/models` resolves the alias, `RUN_INVALIDATED_MODEL_DRIFT` | Reused. Requested model must equal the observed model per receipt. `driftCheck` invalidates mixed identities. |
| Dataset split | `split-v1.json`, by case id | **Not reused for evaluation.** A case-id split leaks entities across dev and holdout. Replaced by a salted split **by business**, and facts never cross. The historical synthetic rows are reused only as engineering material. |
| Baselines | Small normalized-text baseline (numbers, negation, containment) | Replaced by a typed exact-value baseline (money with currency and period, dates, durations, percentages, counted quantities, closed-lexicon conditions). |
| Metrics | Precision/recall, macro F1, Brier, calibration bins, percentiles | Reused. Added a confusion matrix with an `ABSTAIN` column, coverage, abstention rate, high-confidence false positives, ECE, fact-clustered intervals, and effective sample sizes. |
| Drift invalidation | Yes | Reused. |

The Rust harness was not modified. There is no confirmed reason to rewrite it.
The hosted product is TypeScript, so the new adapter is an independent Node
package that uses the official SDK.

## 3. Contracts and label mapping

The contracts are executable in
[`assay.mjs`](../../research/jev-review-assay/assay.mjs). Every receipt records the
question digest, and the full question is stored once per run. The prepared
state contains only evidence: no expected label, reviewer, URL, or human
judgment. Local preflight refuses inputs before transport in these cases:

- The fact was not valid at observation time.
- Retrieval was not observed.
- The supporting span is not verbatim.
- Task B source text is empty or consists only of an HTTP URL.
- The input is malformed or too large.

**Mapping to OpenRecord (`jev-openrecord-label-map-v1`) is explicit and many-to-one:**

| Jev Task A | OpenRecord comparison | Note |
|---|---|---|
| SUPPORTS | MATCHES | "Entire fact in same scope" is stricter than a human MATCHES that agrees on the main value. |
| CONTRADICTS | CONTRADICTS | Candidate only. |
| NOT_ADDRESSED | UNKNOWN | Absence is not contradiction. |
| AMBIGUOUS | UNKNOWN | Partial agreement, conflicting sources, unclear entity, or incompatible unit. |
| no decision (abstain, blocked, error) | none | Never credited as a correct UNKNOWN; counted as lost coverage. |

The reverse direction is undefined. Four-class Jev metrics need a human
`unknownReason` sub-label (`NOT_ADDRESSED` / `AMBIGUOUS`). Without it, only
the collapsed three-class space is scored. Fact-level aggregation copies
OpenRecord's slot rule: any CONTRADICTS wins, then any UNKNOWN, then unanimous
MATCHES. An incomplete fact is null.

Task B has no OpenRecord counterpart. Record judgments compare answers with
facts, not citations with sources, so Task B needs a separate human labeling
instrument.

## 4. Deterministic baseline

[`baseline.mjs`](../../research/jev-review-assay/baseline.mjs) extracts typed
values and compares them literally. It never converts currencies, billing
periods, or date granularities. When a comparison would need an assumption, the
values are `INCOMPARABLE`, which yields AMBIGUOUS. An explicitly negated equal
value conflicts ("does not start on October 25"). It abstains when the fact (or
the claim, for Task B) has no typed value, so qualitative facts are out of
scope. Exact-value slots (quantities, dates, currencies, exact conditions) are
the baseline's job. Jev should be evaluated against it on those slots, not
assumed to be better.

Known limitations, kept visible in tests and results:

- Entity scope is not resolved. A near-name collision yields a false
  CONTRADICTS.
- Semantic equivalences are not recognized ("free" vs USD 0, "run by one
  family" vs "family-owned").
- Digits inside entity names pollute quantity slots.
- Paraphrases with no typed values abstain.

## 5. Shadow evaluation protocol (preregistered before any Jev response)

1. **Units.** The observation is the receipt unit. The **fact** is the
   independent unit for inference. Repeated samples of one fact are
   correlated. Report observations, distinct facts, and distinct businesses.
   The fact count is a clustering proxy, not proof of independence between
   facts from one business. Report the business count alongside it. The optimistic
   bound is the observation count. Intervals are reported at the observation
   level and fact-clustered.
2. **Reference labels.** Labels must be genuine human `record_judgments` (the
   current head of each correction chain). They must be frozen and digested
   before any Jev call. Reviewers must be blinded to Jev output. Disagreements
   are adjudicated by humans. Synthetic material can never satisfy the gate.
3. **Minimum reference set (`REFERENCE_MINIMUMS_V1`).**
   - **Holdout:** at least 30 distinct facts per class (MATCHES, CONTRADICTS,
     UNKNOWN) from at least 8 businesses. No business may supply more than 25%
     of a class.
   - **Dev:** at least 10 facts per class from at least 3 businesses.
   - **Task B:** the same minimums over SUPPORTS, CONTRADICTS, and
     DOES_NOT_ADDRESS, using preserved source text.
   - **Rationale:** at 27/30 the 95% Wilson interval is about [0.74, 0.97];
     smaller sets cannot support an adoption decision.
4. **Split.** Split by business with a salted hash ordering
   (`groupedSplit`, salt `openrecord-jev-shadow-split-v1`, one third holdout).
   Facts never cross. The manifest digest is frozen, and drift fails
   (`SPLIT_DRIFT`).
5. **Threshold policy.** A candidate is emitted only if its selected-label
   probability reaches a threshold. The threshold is the smallest grid value
   whose **dev** CONTRADICTS precision is at least 0.95. Passing any holdout
   item throws `THRESHOLD_TUNING_ON_HOLDOUT`. If no grid value qualifies, the
   policy fails closed and nothing is emitted. The policy digest is recorded
   before the holdout run.
6. **Holdout run.** Run once, with one request per eligible item, zero retries,
   and the budget cap enforced before each request. The model string is fixed.
   Any second observed identity invalidates the run. Failed items stay in the
   denominators.
7. **Metrics** ([`metrics.mjs`](../../research/jev-review-assay/metrics.mjs)):
   - Confusion matrix with an ABSTAIN column.
   - Per-class precision and recall, with abstentions kept in the recall
     denominator.
   - Macro F1 over supported classes.
   - Coverage and abstention rate.
   - High-confidence (≥ 0.90) wrong decisions and false CONTRADICTS.
   - Multi-class Brier score and ECE, from Jev probabilities only.
   - Cost per item, null unless the provider reports it and a dated price
     exists.
   - p50/p95 latency.
   - Deterministic-baseline comparison on the same holdout items, stratified by
     slot kind.
   - Human-review time, only if measured in a separate blinded study.
8. **Adoption criteria.** Holdout CONTRADICTS precision must be at least 0.95
   with a fact-clustered lower bound of at least 0.85, with coverage of at
   least 60% (no precision by abstention). Jev must produce no recurring
   high-confidence false CONTRADICTS pattern. Jev must beat the deterministic
   baseline on the slots the baseline covers, or be confined to the slots it
   does not cover. It must also show a material review-time benefit in a
   blinded human comparison. Without all of these, the verdict is
   `JEV_NOT_RECOMMENDED` or `DEFER`.

## 6. Reference label status (counts only)

Status file: [`status/reference-status.json`](../../research/jev-review-assay/status/reference-status.json).
It contains no business content.

| Task | Item | Count |
|---|---|---|
| A | Grounded observations in the private G2 cohort | 75 (15 facts, 5 businesses) |
| A | Human-judged observations | 15 (15 MATCHES, 0 CONTRADICTS, 0 UNKNOWN) |
| A | Distinct judged facts / businesses | 3 / 1 |
| A | Effective independent n | 3 facts; 1 business |
| A | `unknownReason` sub-labels | 0 |
| B | Citations with preserved source text | 0. Stored grounding metadata keeps only a title and a redirect URI per citation. |
| B | Citation-support human labels | 0 |

The gate (`referenceReadiness`) is evaluated in the best case, as if every
genuine label were in the holdout. It still reports these Task A blockers:

- `REFERENCE_SET_NOT_FROZEN`
- `REVIEW_INCOMPLETE`
- `HOLDOUT_MATCHES_FACTS:3/30`
- `HOLDOUT_CONTRADICTS_FACTS:0/30`
- `HOLDOUT_UNKNOWN_FACTS:0/30`
- `HOLDOUT_BUSINESSES:1/8`
- A business-share violation
- Every dev minimum

Task B is blocked outright. Contradiction precision and recall cannot be
estimated from the current labels. A parallel G2 reconciliation may change
these counts; re-run the gate when it lands.

## 7. Offline results — SYNTHETIC / FIXTURE ONLY

Run: [`reports/offline-v2/summary.json`](../../research/jev-review-assay/reports/offline-v2/summary.json)
and its receipts.

**Adapter contract (authored responses through the real SDK with an in-memory
fetch):** 20 cases, 15 decisions, 5 local refusals, 0 mismatches, 0 provider
requests.

**Deterministic baseline on synthetic holdouts.** The baseline was written with
all synthetic templates visible, so these figures are not an unbiased estimate:

| Corpus (holdout) | Items / facts / businesses | Macro F1 | Coverage | Decided accuracy | Notable errors |
|---|---|---|---|---|---|
| Historical Task A rows, claim-centric, 4-class | 80 / 80 / 2 | 0.757 | 0.85 | 0.824 | 4 false CONTRADICTS (near-name collision); 8 PARTIAL scored SUPPORTS |
| Historical Task B rows, 3-class | 67 / 67 / 2 | 0.797 | 0.88 | 0.864 | Paraphrase entailment abstains; ambiguous pronoun scored SUPPORTS |
| Fact-centric Task A, OpenRecord space | 60 / 12 / 3 | 0.872 | 0.75 | 1.000 | All abstentions are qualitative facts |
| Fact-centric Task A, fact level | 12 / 12 / 3 | 0.611 | 0.75 | 1.000 | n = 12 facts |
| Fact-centric Task B, preserved source | 15 / 15 / 3 | 0.889 | 0.80 | 1.000 | 9/9 URL-only items abstained before comparison |

Across the whole fact-centric Task A corpus, the baseline decided every
synthetic price, date, and duration slot (135 items), with 131 correct and 0
false CONTRADICTS. The 4 misses were "plan is free" against a USD price. It
abstained on all 45 qualitative items. This only supports routing exact-value
slots to deterministic checks first. It does not show real-world accuracy.

**Harness pipeline exercise.** Authored perturbed oracle, labeled
`NOT_A_MODEL_RESULT`. The responder copies the constructed label and flips
about 10% of them at probability 0.93. The exercise drives the real SDK
response handling, receipts, budget (180 + 45 requests planned and used,
offline), drift check (`NO_DRIFT`), dev-only threshold selection, and holdout
scoring. The dev CONTRADICTS precision never reached 0.95, so the frozen policy
failed closed and holdout coverage after the policy was 0. The raw holdout run
had 3 high-confidence false CONTRADICTS (Task A) and 1 (Task B), which shows
the metric catches that pattern. These scores describe the authored responder,
not Jev.

Real-label metrics: precision 0/0, recall 0/0, latency unknown, cost per item
unknown. A zero denominator is not a zero error rate.

## 8. Live readiness (all must be VERIFIED; none is)

The checklist is [`status/live-readiness.json`](../../research/jev-review-assay/status/live-readiness.json).

| Requirement | Status | What is needed |
|---|---|---|
| Current API contract | UNVERIFIED | Offline: SDK 0.7.0 declarations show `systemOne`, `choice → {choice, confidence, probabilities}`, `usage` that may be null, and `models.list → {name, description, release_date}`. Re-check current provider docs and changelog, and record the URL, date, and SDK version. |
| Model identity | UNVERIFIED | Default alias `jev-latest`; no immutable version field is documented. Snapshot `models.list`, fix one model string, require equality on every receipt, and invalidate on drift. Otherwise record `UNSUPPORTED_BY_PROVIDER`. |
| Pricing | MISSING | A dated price sheet. Unknown cost blocks paid execution. |
| Credential scope | MISSING | A dedicated, revocable research key, spend-capped, never shared with production or logged. No key was used. |
| Permission to transmit evidence | NOT GRANTED | Written permission from the evidence owner, and from businesses where needed, to send the exact frozen corpus. Review of provider retention and training terms. The repo is public and evidence stays private. |
| Spending bound | UNVERIFIED | `requests × (max input tokens × input price + max output tokens × output price) + fees`. Input is at most 24,000 characters of state plus the question. Requests equal holdout items, with zero retries. Needs prices first. |
| Approval | MISSING | Owner approval naming the model string, corpus digest, maximum requests, and maximum USD. |

## 9. Recommendation

`DEFER`. Do not integrate Jev into production. The primary blocker is reference
labels: there are no genuine contradiction or uncertainty cases, and no
preserved citation text. Next steps, in order:

1. Complete and freeze G2-style human review across at least 11 businesses to
   reach the minimums. This needs real contradictions; they cannot be
   manufactured.
2. Record an `unknownReason` sub-label for every human UNKNOWN.
3. Preserve cited source text at collection time if Task B matters.
4. Clear the live checklist.
5. Run the holdout once under this protocol.

On exact-value slots, use the deterministic checks first. Consider Jev only as
a human-review aid for qualitative slots, and only if the holdout meets the
criteria in §5.

## 10. Reproduce

Use Node 24 from the repository root. No credentials or network are needed
after `npm ci`.

```sh
npm ci --prefix research/jev-review-assay --ignore-scripts --no-audit --no-fund
npm test --prefix research/jev-review-assay          # 44 tests
npm run fixtures --prefix research/jev-review-assay -- reports/new-run
```


## 11. Offline safeguards in protocol v1.1

The completion pass reuses commit `babd80e`. It adds no production imports,
provider transport, or dependencies. No live holdout response exists, so these
corrections precede empirical evaluation.

- Split manifests bind sorted complete input rows, including evidence and
  reference labels, as well as split membership. Evidence edits, label edits,
  modified manifest fields, duplicate IDs, and invalid split fractions fail.
  Validate the frozen manifest with `assertSplitIntegrity` before future
  evaluation. Freeze canonical source rows before adding predictions or metrics.
- Citation URL-only input abstains locally without consuming a request budget.
  Preserved text still requires human verification of provenance and relevance.
- Spending bounds require finite nonnegative prices and request fees, and safe
  nonnegative integer token limits. Unknown values and overflow block execution.
  The bound assumes the provider contract actually enforces those token limits.
- Request plans reject missing, fractional, or negative counts. Zero planned
  requests are valid for an empty eligible set. Mixed reported model identities
  invalidate a run even if the changed model's decision failed validation.

The committed `reports/offline-v2` remains the historical v1 artifact. New v1.1
runs use a separate output directory. Their digests differ by design. The 44
research tests include three new regression tests that fail on the prior code.
The fixture runner retains 20 adapter cases and 225 authored pipeline responses;
it makes zero provider requests. Neither synthetic holdouts nor authored oracle
responses establish generalization, real-world calibration, or human time savings.

The live checklist is a preparation aid, not an execution authorization system.
No live executor exists here. A future executor needs separate review, a private
immutable manifest covering source and label digests, model discovery receipts,
explicit approval for that corpus and spend, token limits, and completion receipts.
