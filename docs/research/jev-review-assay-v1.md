# Jev evidence-review shadow assay v1

Recommendation: **DEFER**.

The offline assay verifies the two Choice contracts and their safety boundaries.
It provides no evidence that Jev improves review accuracy or saves human effort.
There were zero live Jev requests, zero evaluated Gemini observations, and zero
genuine human labels in this assay. No paid requests were authorized or made.
This report does not assert that genuine observations or reviews are absent from
other environments. No customer database was queried or exported.

## Current implementation and decision ownership

The review inspected the product map, Record Integrity architecture, record
repository and read model, hosted provider contracts, Gemini adapter, and prior
Rust Jev research. The relevant implementation references are:

- [Product map](../product/openrecord-product-map-ste100.md).
- [Record Integrity rules](../architecture/record-integrity-v1.md).
- [`RecordRepository.judge`](../../packages/db/src/record.ts), including temporal
  fact binding, exact-span handling, append-only corrections, and session actor.
- [`compareSlot`, `findingFor`, and `publicRecord`](../../packages/db/src/record-view.ts).
- [Hosted providers](../../packages/providers/src/index.ts) and
  [Gemini](../../packages/providers/src/gemini.ts).
- [Older Jev assay](../../research/jev-assay/README.md), its frozen
  [protocol](../../research/jev-assay/PROTOCOL.md), and
  [Rust implementation](../../src/jev_assay.rs).

A human decides whether a fact is approved, whether an answer matches or
contradicts that fact, and what an ambiguous answer means. The legacy issue loop
and prospect assay also require their own human reviews. Jev's candidate labels
are separate from all of these judgments.

The following checks are deterministic:

- Tenant and session membership, actor identity, and append-only history.
- The fact version bound to an observation and its validity window.
- Exact, case-sensitive quotation membership in an answer or source text.
- Arithmetic over sample counts, date ordering, and sampling-policy checks.
- Observed retrieval evidence, surface comparability, and run completeness.
- Findings and outcomes derived from stored human judgments and recorded actions.
- Public projection, approval visibility, and share revocation.

Jev performs none of these checks. An exact quote establishes that text occurs,
not that the text supports a claim. Requested search does not prove retrieval.
`UNKNOWN` never becomes agreement or contradiction through this assay.

The old Rust protocol combines Noul questions into different labels and includes
an experimental `AUTO_CLASSIFY` disposition. This task neither changes nor adopts
that policy. The new protocol is `openrecord-jev-shadow-review-v1`.

## Decision contracts

The executable question definitions are in
[`assay.mjs`](../../research/jev-review-assay/assay.mjs). Every receipt includes the
complete question and its SHA-256 digest. The model receives evidence as data,
never the expected fixture label or a human review.

Decision A receives a fact with identity, version, and authority label, an AI
answer, an exact supporting span, and required context. Context must identify the
business, relevant scope, currency or billing basis, and any conflicting evidence.
The caller establishes temporal eligibility and observed retrieval outside Jev.
The local preflight refuses ineligible facts, missing retrieval, and invalid spans.

Allowed Choice labels are:

- `SUPPORTS`: the answer agrees with the entire supplied fact in the same scope.
- `CONTRADICTS`: the answer makes an incompatible assertion in the same scope.
- `NOT_ADDRESSED`: the answer does not address the fact.
- `AMBIGUOUS`: the evidence requires assumptions or contains partial agreement,
  unclear entities, incompatible units, or conflicting sources.

`PUBLIC_SOURCE_UNAPPROVED` facts remain source-relative. A candidate contradiction
means disagreement with the supplied public-source fact. It does not establish
that the business is wrong. Neither `NOT_ADDRESSED` nor `AMBIGUOUS` maps to an
official record decision. There is no automatic mapping to `record_judgments`.

Decision B receives an AI claim, the cited source text, and required source
context. A reviewer may also provide a quotation for local exact-text checking.
No source fetch occurs. A URL without source text yields `SOURCE_TEXT_MISSING`
before the SDK runs.

Allowed Choice labels are:

- `SUPPORTS`: the source supports the full claim in the same scope.
- `CONTRADICTS`: the source explicitly conflicts with the claim in the same scope.
- `DOES_NOT_ADDRESS`: the source establishes neither support nor contradiction.

Decision B has no ambiguous label. Partial support or conflicting context uses
`DOES_NOT_ADDRESS` and remains for human review. This coarse label is a known limit.

Responses must contain the exact allowed labels, finite probabilities in [0, 1]
that sum to 1 within 0.001, and a selected label with maximal probability. Reported
confidence is retained separately from the selected-label probability. Invalid
responses and transport failures yield no candidate decision.

## Isolation and receipts

The standalone package is under `research/jev-review-assay`. It is outside the
pnpm workspace. Its own lockfile pins the official `@typesafe-ai/sdk` to `0.7.0`.
The hosted dependency graph and root lockfile are unchanged by this task.
The SDK version was verified from npm and its installed declarations on this run.
See the [official JavaScript SDK documentation](https://docs.typesafe.ai/sdk/javascript)
and [official SDK source](https://github.com/typesafe-ai/typesafe-sdk-js).

The only executable transport supplies an in-memory HTTP fixture to the real SDK.
It overrides credentials, base URL, model, logging, compression, retry policy, and
fetch. It never delegates to global fetch. Ambient TypeSafe environment variables
cannot activate a live request. The CLI accepts only an output directory; it has
no live mode or customer-data input option.

Receipts preserve case and input digest, protocol and question definitions,
requested and observed model, complete Choice probabilities, confidence,
local elapsed time, token usage, cost basis, status, and safe error class.
Fixture token counts are explicitly marked `usageSource: FIXTURE`; they are not
billable usage. Fixture elapsed times include local SDK work and measure no model
latency. Cost is zero with `NO_PROVIDER_REQUEST`, not a claim that Jev is free.
SDK error bodies, credentials, headers, and stacks are not persisted in receipts.
Missing usage stays null. Invalid model identity fails closed.

The executable runner uses synthetic material only. `prepare` recognizes declared
`PUBLIC` material for a future manually reviewed input contract. That declaration
is not a confidential-data detector or proof of data-sharing permission.
No live runner or customer export has been implemented. Before either exists,
data-sharing terms and each candidate input require review. Future receipts must
retain exact requested and provider-reported identities, explicit missing usage,
and a dated price basis or unknown cost. Model aliases must not be silently
substituted. Current prices and an explicit request and spend limit need approval
before any live execution.

There are no database imports, database writes, API routes, UI suggestions,
automatic findings, or derived outcomes in this research package. Architecture
tests check that hosted code does not import the research package or TypeSafe SDK.
Gemini remains the observation provider. Its validation gates are unchanged.

## Corpus and fixture results

The corpus contains 20 authored synthetic cases: 13 for Decision A and 7 for
Decision B. It covers changed prices, different currencies, changed dates,
expired policies, missing retrieval, misleading citations, partial answers,
conflicting sources, ambiguous names, public-source authority, nonverbatim spans,
URL-only evidence, and instructions embedded in evidence.

Dates and price differences are literal semantic examples. Jev is not asked to
calculate a difference, compare dates, establish exchange rates, or choose a fact
version. The expired-policy fixture supplies a false eligibility flag and proves
a local refusal. It does not test the production validity implementation.

The 20 cases produced 15 fixture decisions and 5 local skips, with zero contract
mismatches and zero unexpected errors. The response label and probabilities are
authored by the fixture. In particular, the prompt-injection case proves transport
handling only, not that Jev resists prompt injection.

The test suite passed 30 tests. Besides the cases, it checks malformed outputs,
model drift, transport failures, no retries, exact quotations, denied global
network access, ambient credentials, isolation, metric arithmetic, and refusal to
overwrite a report directory. An output directory must be new. Partial output
from a filesystem failure remains inspectable and must not be treated as complete
without `summary.json`.

Evidence is in [receipts](../../research/jev-review-assay/reports/offline-v1/receipts.jsonl)
and [summary](../../research/jev-review-assay/reports/offline-v1/summary.json).

## Live results and metric denominators

Live execution status is `NOT_EXECUTED`. Evaluated genuine human labels total 0.
Candidate-contradiction precision is unavailable, with numerator 0 and denominator
0. Recall is unavailable, with numerator 0 and denominator 0. False-positive rate,
incorrect high-confidence decisions, uncertainty handling, and citation-support
accuracy are also unavailable. A zero denominator is not a zero error rate.
Live latency, live token usage, cost per observation, and human effort saved are
unknown. Synthetic labels do not enter statistical accuracy claims.

The pure `classificationCounts` function verifies metric arithmetic. It does not
verify label provenance. For a future genuine evaluation, report counts separately
for A and B and retain:

- Contradiction precision: true candidate contradictions divided by all candidate
  contradictions, with true positives and false positives shown.
- Contradiction recall: detected human-confirmed contradictions divided by all
  human-confirmed contradictions. Failed or skipped cases remain in this denominator.
- False-positive rate: false candidate contradictions divided by human negatives.
- Incorrect high-confidence decisions: wrong selected labels with selected-label
  probability at least 0.90 divided by all decisions meeting that threshold.
- Uncertainty handling: exact preservation of adjudicated `NOT_ADDRESSED`,
  `AMBIGUOUS`, or `DOES_NOT_ADDRESS` divided by all such labeled cases. Report
  transitions into false contradiction separately.
- Citation-support accuracy: correct B labels divided by all eligible adjudicated
  B cases. Missing decisions count as incorrect, with coverage also reported.
- Wall time per observation, p50 and p95 request latency, attempts, failures,
  reported tokens, and total attributable cost divided by observations processed.

The current summary deliberately leaves these quality metrics null. Arithmetic
examples in unit tests are fabricated numbers, not human reviews or model results.

## Blinded workflow comparison before adoption

No human comparison ran. Once real Gemini observations and genuine human reviews
exist, the proposed evaluation is:

1. Review data-sharing terms and restrict the first corpus to approved public
   evidence. Obtain explicit authorization for the exact live model and budget.
2. Freeze corpus IDs, source snapshots, fact versions, question digests, model
   identity, metrics, sampling plan, and acceptance criteria before live calls.
   Keep development and held-out cases separate. Preserve failed cases.
3. Have human reviewers label the evidence without seeing Jev results. Record
   actual reviewer provenance through the authenticated review workflow. Resolve
   label disagreement through independent human adjudication. Scripts never
   fabricate reviews or write official judgments.
4. Run a separately authorized shadow collector against the frozen inputs. Retain
   probabilities, observed identity, usage, errors, and current cost evidence.
5. Compare human-only review with Jev-assisted review in a research exercise.
   Randomize which reviewer sees suggestions, counterbalance difficulty, and avoid
   showing one reviewer the same case twice. Keep reference adjudicators blinded.
   Record active review time, final accuracy, overridden suggestions, and follow-up
   work in both arms. Include training and suggestion inspection in effort totals.
6. Report denominators and uncertainty intervals, separately by decision, failure
   type, and difficult-case category. No percentage alone establishes benefit.
   Predefine a material time-saving target and acceptable error rates with the
   product owner before exposing the held-out corpus. Do not tune on that corpus.
7. Recommend `ADOPT` only if the human-labeled comparison demonstrates that target
   without unacceptable false positives or reduced review quality. Adoption would
   require a separate production-boundary review and explicit authorization.

An added dependency is not justified by fast fixture execution. Defer while data
or authorization is missing. Reject if important contradictions are missed,
high-confidence errors recur, citation support is unreliable, suggestions add
review work, or the measured benefit is too small. Human reviewers remain the
sole authority even if a later assay recommends adoption.

## Verification and intentionally unchanged files

Run with Node 24, from the repository root:

```sh
npm ci --prefix research/jev-review-assay --ignore-scripts --no-audit --no-fund
npm test --prefix research/jev-review-assay
npm run fixtures --prefix research/jev-review-assay -- reports/new-run
pnpm --filter @openrecord/db exec vitest run src/record-view.test.ts src/record-architecture.test.ts
pnpm --filter @openrecord/providers test
git diff --check
```

Verified results: 30 new assay tests, 22 record view and architecture tests, and
45 hosted provider tests passed. These are local offline checks. No live-provider,
customer, deployed-service, or new database-migration validation is claimed.

This task changes only the new research directory and this report. Existing dirty
edits remain in the workspace. Production review code, migrations, human judgments,
Record Integrity semantics, the older Rust assay, Gemini adapters, and current
Gemini validation gates are intentionally unchanged by this task.
