# OpenRecord Product Reality V1 — execution ledger

Starting commit: `6a37ea46abea458e3de037c03371d0c4c9e5fa01` (`origin/main`).
Working tree at start: clean.
Source of truth: the code at that commit.
Writing standard: ASD-STE100 Issue 9 rules as supplied in the task.
The official dictionary needs a request form, so this document reports
`STE_ALIGNED_NOT_FULLY_VERIFIED`.

## Executive summary

OpenRecord runs. The product path works end to end. G1 passes. One real,
retrieval-backed Gemini observation is stored, with citations, raw bytes and a
matching digest. Section 3.6 holds the evidence.

The first attempt failed with HTTP 429 `RESOURCE_EXHAUSTED`, because Google
Search grounding needs a paid-tier project. The operator enabled access. The
retry then succeeded on the same key, model, fact and question.

G1 is `PASS`. G2 ran on 2026-10-17 inside the approved $5 budget. G2 is
`G2_PARTIAL_COHORT`: 5 of 7 businesses, 75 of 105 samples, all grounded, no
failures. Two businesses are `SOURCE_BLOCKED`. Every observation awaits human
review. No judgment exists, so no precision and no finding exists yet. G3 to G5
did not start. No customer, review, or payment was invented. No engineering
change was necessary.

## 1. Starting state

| Item | Value |
|---|---|
| Repository | `commonfields/openrecord` |
| Starting SHA | `6a37ea46abea458e3de037c03371d0c4c9e5fa01` |
| Working tree | Clean |
| PR #49 (`OPENRECORD_RECORD_INTEGRITY_V1`) on main | Yes. Merge commit `decb5fe` |
| PR #51 (product map STE100 v1) on main | Yes. Merge commit `6a37ea4`. File `docs/product/openrecord-product-map-ste100.md` present |
| Branch for this work | `docs/openrecord-product-reality-v1`. Merged through PR #52, merge commit `37cb33d` |

Verification commands: `git log --oneline -3 origin/main` and
`git cat-file -e origin/main:docs/product/openrecord-product-map-ste100.md`.

PR #52 also carried one unrelated web commit, `fa0c626` (business mark colors).
It is not part of this validation work.

Public-text cleanup: a later documentation change removed business-level source
details, local identifiers and commercial terms from this document. Earlier
versions remain in the public git history. Removed details are kept in the
operator's private evidence folder.

## 2. Acceptance gates

| Gate | State | Evidence | Human dependency | Next action |
|---|---|---|---|---|
| G1 Live execution | PASS | Observation stored with `PROVIDER_GROUNDING`; check run `7b7dccd6…`; digest `8073697f…` | None. Paid-tier access is active | None. G1 is complete |
| G2 Evidence quality | PARTIAL_COHORT | 75 of 105 samples collected, 75 grounded, 0 failed. Section 4 | Real reviewer decisions on 75 observations | Operator reviews the queue. VB-06 and VB-07 need first-party sources |
| G3 Product delivery | BLOCKED | No authorized customer | One real agency and one real client | Confirm a customer, then deliver |
| G4 Repeat value | NOT_STARTED | Depends on G3 | Agency action and a second check | Start after G3 passes |
| G5 Payment | BLOCKED | No customer, no offer sent | Operator confirms the offer | Send the offer after approval |

G2 collection is done for every business with verifiable sources. G2 now
waits for human review, not for a defect.

Each gate is independent. No gate was reported from a lower gate.

## 3. G1 — Live execution

### 3.1 Environment verification

| Check | Result | Evidence |
|---|---|---|
| Node version | 24.3.0 | `node --version`; `package.json` `engines.node` = `>=24 <25` |
| PostgreSQL version | 16.15 | `docker exec openrecord-postgres-1 psql -U openrecord -d openrecord` |
| Database is OpenRecord's instance | Yes | Container `openrecord-postgres-1`, image `postgres:16-alpine`, database `openrecord` |
| Record tables present | Yes | `record_profiles`, `record_runs`, `record_items`, `record_item_approvals`, `record_judgments`, `record_actions`, `record_shares`, `observations`, `raw_evidence`, `provider_attempt_evidence` |
| `.env` key inventory | `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `SESSION_SECRET` | Read without printing values |
| `GEMINI_API_KEY` | CONFIGURED | Present, not a placeholder |
| API and worker model config | Shared, one source | Both read `RecordSurfaceConfig` and `GeminiModel` from `packages/config/src/index.ts` |

The API stores the requested model when it starts a run.
Source: `apps/api/src/record-routes.ts` (`startRun`, `requestedModel` set from the configured surface model).
The worker sends that model to the provider.
Source: `apps/worker/src/check-runner.ts` (`providers.observe({ requestedModel: claimed.requestedModel })`).

### 3.2 Model availability

| Model | Project access | Evidence |
|---|---|---|
| `gemini-2.5-flash` | No | HTTP 404: "no longer available to new users" |
| `gemini-2.5-flash-lite` | No | HTTP 404, suggests `gemini-3.5-flash-lite` |
| `gemini-2.5-pro` | No | HTTP 404 |
| `gemini-3.5-flash-lite` | Yes | `countTokens` HTTP 200, `totalTokens` = 2 |
| `gemini-3.8-flash` | Yes (listed) | Model metadata HTTP 200 |

The Models API lists 63 models. A listing is not proof of use.
`gemini-2.5-flash` was listed, but the call failed.

The operator selected `gemini-3.5-flash-lite`. The local `.env` now sets
`GEMINI_MODEL=gemini-3.5-flash-lite`. The previous value was `gemini-2.5-flash`.

### 3.3 Grounding and pricing

Google pricing page, read 2026-10-17 (page updated 2026-10-13).

| Tier | `gemini-3.5-flash-lite` tokens | Grounding with Google Search |
|---|---|---|
| Free | Free of charge | Not available |
| Paid, Standard | Input $0.30 / 1M tokens; output $2.50 / 1M tokens | 5,000 free search requests per month, shared across Gemini 3 and newer models, then $14 per 1,000 requests |

Google bills each search query that the model runs. One prompt can run several
queries. Google does not bill a failed request.

The 2.5 tier has free grounding on the free tier. Google blocks that tier for
this project, so the free path is closed.

### 3.4 Live smoke test, first attempt (blocked)

Method: the real product path.

```text
Authenticated API -> queued check -> worker -> Gemini -> stored observation
```

Work completed, through the live HTTP API only:

1. Signed in as the local demo operator.
2. Created one client with three facts and three buyer questions.
3. Approved one fact only, to bound the test.
4. Started one run with one sample.
5. Waited for the worker.

Result: the check failed.

| Field | Value |
|---|---|
| Requested model | `gemini-3.5-flash-lite` |
| Run status | `FAILED` |
| Failure class | `PROVIDER_RATE_LIMITED` |
| Provider status | HTTP 429 |
| Provider body | "You exceeded your current quota, please check your plan and billing details." Status `RESOURCE_EXHAUSTED` |
| Attempts | 4, all HTTP 429 |
| Attempt evidence | 1,234 bytes per attempt, stored with a digest, content type `application/json; charset=UTF-8` |
| Observations stored | 0 |
| Provider substitution | None |

The worker retried four times, because HTTP 429 is retryable. The retry ceiling
is code, not configuration.
Source: `apps/worker/src/check-runner.ts` (`MAX_PROVIDER_ATTEMPTS = 4`).

### 3.5 Diagnostic: model access against grounding

One bounded diagnostic call separated model access from grounding access.

| Call | Result |
|---|---|
| `generateContent` without the search tool | HTTP 200, answer "ok" |
| `generateContent` with the `google_search` tool | HTTP 429 `RESOURCE_EXHAUSTED` |

Token use of the diagnostic: 7 input tokens, 1 output token.

Conclusion: on the free tier, the project can call the model but cannot use
grounding. This matches the Google tier table: grounding is not available on the
free tier for Gemini 3 models. The operator then enabled paid-tier access, and
section 3.6 records the result.

### 3.6 Live smoke test, retry (passed)

The operator enabled paid-tier access and supplied a new `GEMINI_API_KEY`. The
API and the worker restarted on Node 24 with the new environment. The retry used
the same business, the same approved fact, the same buyer question, the same
model, and one sample. The measurement conditions did not change.

A local script signed in, started one `INITIAL` run through the HTTP API, and
polled the operator view.

The check succeeded. Every acceptance item below is verified against stored
evidence, not against the provider response alone.

| Acceptance item | Result |
|---|---|
| Request succeeded | Yes. Check status `SUCCEEDED`; the worker logged "check succeeded" |
| Correct model answered | Yes. Requested model and observed model are both `gemini-3.5-flash-lite` |
| Response has grounding metadata | Yes. `retrieval_requested = true`, `retrieval_observed = true`, `retrieval_mode = PROVIDER_GROUNDING` |
| Retrieval tool recorded | Yes. `retrieval_tool = google_search`, with 2 web search queries stored |
| Raw response stored | Yes. 9,499 bytes, content type `application/json; charset=UTF-8`, limit 2,097,152 bytes |
| Evidence digest stored | Yes. Digest prefix `8073697f` |
| Digest matches the stored bytes | Yes. `observation.raw_digest = raw_evidence.digest` |
| Citations preserved | Yes. 4 citations, all attributed. 2 from the business's own domain, 2 from third-party sites |
| Observation is not synthetic | Yes. `synthetic = false` |
| No provider substitution | Yes. Provider `gemini`; requested model equals observed model |
| Public evidence rules intact | Yes. 0 shares. 0 judgments. An unreviewed answer is not public |

| Field | Value |
|---|---|
| Business | One hotel from the cohort (VB-01) |
| Check run | Prefix `7b7dccd6` |
| Run status | `SUCCEEDED` |
| Observations stored | 1 |
| Answer | Stored in OpenRecord and in the private evidence folder |
| Token use | 23 input tokens, 161 output tokens, 184 total |
| Service tier | `standard` |
| Finish reason | `STOP` |

The G1 answer is an observation for the reviewer. This document does not judge
it. Only a human decides. Section 4.5 refers to the review protocol.

An earlier version of this section compared the answer with a first-party page
fetched for cohort preparation. A later fetch of the same page, on the same day,
showed different content. G2 froze the later content. That early comparison is
not a finding.

### 3.7 G1 verdict

`PASS` — `LIVE_GROUNDED_OBSERVATION_VERIFIED`

One real, retrieval-backed observation is stored with raw bytes, a matching
digest, preserved citations, the requested model, and `synthetic = false`. The
public evidence rules remain intact.

The first attempt failed because the project had no grounding entitlement. That
was an entitlement problem, not a code problem. No code changed to pass this
gate.

### 3.8 Cost of G1

| Item | Result |
|---|---|
| Successful grounded call | 23 input tokens, 161 output tokens. About $0.00041 |
| Search queries | 2, inside the 5,000-per-month free allowance. $0 |
| First attempt | 4 requests, all rejected with HTTP 429. Not billed |
| Diagnostic call | 8 tokens total. Under $0.00001 |
| Observations stored | 1 |
| Total estimated charge | About $0.00043. The approved cap was $1 |

The rate card: `gemini-3.5-flash-lite` input $0.30 per million tokens, output
$2.50 per million tokens. Search grounding: 5,000 free requests per month, then
$14 per 1,000 queries.

### 3.9 Cost estimates for later work

One smoke test: tokens only, about $0.001 at most. Search stays inside the
monthly free allowance. Expected cost: near zero.

105 cohort samples, normal case: 105 prompts, 1 to 3 search queries each.
Search stays inside the 5,000 free monthly queries. Token cost about $0.08.
Expected total: under $0.30.

105 cohort samples, worst case: 105 samples times 4 attempts equals 420
requests. Three queries each equals 1,260 queries. If the free monthly
allowance is used, cost is 1,260 times $0.014, or $17.64. Token worst case adds
about $0.65. Absolute ceiling: about $18.29. Failed requests add no charge.

The operator approved the G2 budget of $5 on 2026-10-17. A billing alert is
not a hard spending limit. A provider-side quota is the only hard cap; section
4.4 records how G2 stayed inside the budget.

Approved G2 plan:

| Item | Value |
|---|---|
| Cohort | 7 businesses, unchanged, from `docs/validation/record-integrity-real-business-v1.md` |
| Facts | 3 per business, 21 total |
| Buyer questions | 3 per business, 21 total |
| Samples per fact | 5 |
| Planned samples | 105 |
| Retries | No selective retries. Every failed sample stays in the denominator |
| Stop rule | Report the precision ledger at 3 of 7 businesses with promising yield, only after all 7 are evaluated. Section 4.1 records why it did not apply |
| Budget | $5. Normal case about $0.30 |
| Model | `gemini-3.5-flash-lite`, `google_search` grounding |

## 4. G2 — Evidence quality

State: `G2_PARTIAL_COHORT`. Collection ran on 2026-10-17. All observations
await human review.

### 4.1 Result

| Item | Value |
|---|---|
| Businesses evaluated | 5 of 7 |
| Facts frozen | 15 of 21 |
| Samples attempted | 75 of 105 |
| Samples completed | 75 |
| Failed attempts | 0 |
| Retries | 0. Every provider attempt succeeded on attempt 1 |
| Grounded observations | 75 of 75, `PROVIDER_GROUNDING` |
| Synthetic observations | 0 |
| Citations | 239 |
| Human judgments | 0 |
| Confirmed meaningful findings | 0. Review is not done |
| Question binding mismatches | 0 of 75 |

The 3-of-7 stop rule did not apply. Two businesses could not be evaluated.
Selection limitation: the two blocked businesses are large retailers. The
evaluated set is four small service businesses and one large retailer.

### 4.2 Per business

| ID | Sector | Facts | Attempted | Completed | Failed | Grounded | Awaiting review | Reviewed |
|---|---|---|---|---|---|---|---|---|
| VB-01 | Hotel | 3 | 15 | 15 | 0 | 15 | 15 | 0 |
| VB-02 | Hotel | 3 | 15 | 15 | 0 | 15 | 15 | 0 |
| VB-03 | Urgent care | 3 | 15 | 15 | 0 | 15 | 15 | 0 |
| VB-04 | Urgent care | 3 | 15 | 15 | 0 | 15 | 15 | 0 |
| VB-05 | Online retail | 3 | 15 | 15 | 0 | 15 | 15 | 0 |
| VB-06 | Retail | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| VB-07 | Retail | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

### 4.3 Source truth

Every fact was frozen from a first-party page fetched on 2026-10-17, before
the first sample of its business. Every fact keeps `PUBLIC_SOURCE_UNAPPROVED`.
No business approved a fact. No business was contacted. No frozen fact was
changed after sampling.

Fact types: prices, hours, check-in and check-out times, return windows,
cancellation terms, and service availability.

| Item | Value |
|---|---|
| Facts frozen | 15, from 5 first-party sources |
| Facts with a source flag for the reviewer | 4. Flags describe the source, not the answer |
| Businesses `SOURCE_BLOCKED` | 2. No first-party page could be retrieved. No fact was guessed |

Fact values, source pages and flags are in the private evidence folder.

### 4.4 Cost

| Item | Value |
|---|---|
| Provider calls | 75, all HTTP 200 |
| Search queries | 105. Maximum 3 in one check |
| Tokens | 1,325 input, 12,819 output. Maximum 762 output in one check |
| Token charge, estimated | About $0.03 |
| Search charge, estimated | $0 inside the free monthly allowance. $1.50 if every query is billed |
| Total, estimated | About $0.03 likely. About $1.53 at most |
| Remaining of $5 | At least about $3.47 |
| Incomplete batches | 0. VB-06 and VB-07 did not start |

These values are estimates from response metadata, not an invoice. The code sets
no output-token limit, and the worker allows 4 attempts for each check. No hard
spending cap exists in code. Each batch started only when a conservative upper
bound fit the remaining budget: 15 checks, 4 attempts each, output and queries
above the observed maximums.

### 4.5 Review

Reviewers supply every judgment. The agent prepared a review package only and
submitted no judgment. The package, the raw operator views and the source pages
are in a private evidence folder, not in this repository. Raw provider bytes and digests are in
OpenRecord. The review protocol is in
`docs/validation/record-integrity-real-business-v1.md`.

## 5. G3 — Delivery

State: `BLOCKED_REAL_CUSTOMER`.

No authorized agency or client exists. No link was sent. No test account was
presented as a customer.

Prepared delivery package, ready to use after operator approval:

| Item | Content |
|---|---|
| Workspace | One client record, three approved facts, three questions |
| Evidence | Grounded observations, citations, retrieval state |
| Judgments | Reviewer decisions through the product review path |
| Explanation | One page. What the question was, what the provider answered, what the reviewer decided |
| Deliverable | One read-only share link |
| Controls | Revocation; private notes and unreviewed answers stay hidden |

The public projection hides unreviewed answers, internal notes, database ids and
raw payloads. Source: `packages/db/src/record-view.ts` (`publicRecord`). Test:
`packages/db/src/record-view.test.ts` ("keeps drafts private and drops unsafe
links, ids, notes and provider internals").
Revocation is permanent. Source: `apps/api/src/record-routes.ts` (`share/revoke`).

Outreach draft, not sent: one short message to one agency, offering one free
evidence record for one client, with no fee and no obligation. Sending needs
explicit operator authorization.

## 6. G4 — Repeat value

State: `NOT_STARTED`. G4 needs a delivered record and a real external action.
Neither exists. No outcome type was assigned. No polite interest was recorded
as a renewal.

## 7. G5 — Payment

State: `BLOCKED`. No offer was sent. No transaction was created.

Prepared offer, not sent:

| Item | Content |
|---|---|
| Scope | One pilot, three client records, four weekly checks |
| Deliverable | Three share links with facts, answers, judgments and outcomes |
| Price | A hypothesis held by the operator, not in this document |
| Evidence ledger | Customer, scope, price, payment date, payment status, delivery commitment |
| Renewal test | Does the agency request a fifth check without prompting? |

The operator must confirm the offer before any send. Private payment details
stay out of this repository document.

## 8. Automated correction

OpenRecord does not change an external provider answer, and this is not a
failure. The agency controls its own website and content. OpenRecord keeps the
evidence, records the work, and measures the observed result.

The manual step did not block this execution. Provider access did block the
first attempt, and paid-tier access solved it. The current product gives the
agency a complete manual loop. Source:
`packages/db/src/record-view.ts` (`CAUSALITY_DISCLOSURE`, `RESOLVED_EXTERNALLY`).

No autonomous correction was added. The Search Operator was not expanded.

## 9. Engineering changes

No change was necessary to unblock G1. The blocker was provider entitlement.
Paid-tier access solved it. No code was changed in this execution.

One candidate defect is recorded for owner review, not fixed here:

Some local rows have `provider = 'mock'` and `synthetic = false`. They predate
the `synthetic` column. The evidence read layer normalizes them as fixtures.
Source: `packages/db/src/evidence.ts` (observation read, `synthetic`). The record
read path selects the stored flag directly. Source: `packages/db/src/record.ts`
(record check query). No record run
holds these rows today, so the product cannot misreport them now.

Fixing this would change evidence semantics. The task forbids that without
authorization. No product code was changed by this validation work.

## 10. Environment changes

| Change | Detail |
|---|---|
| `.env` | `GEMINI_MODEL` changed from `gemini-2.5-flash` to `gemini-3.5-flash-lite`. `GEMINI_API_KEY` replaced by the operator with a paid-tier key. This document does not print or store the secret |
| API | Stopped and restarted with Node 24.3.0. Listening on port 3001 |
| Worker | Two worker instances were running. Both stopped. One worker restarted with Node 24.3.0 |
| Web | Left running on port 3000 |
| Database | G1: one client record and one observation. G2: five client records, 15 facts and 75 observations, all through the product API. No volume deleted. No migration added. 0 shares. 0 judgments |
| PostgreSQL 14 (Homebrew) | Not touched |
| Provider calls | G1 first attempt: 4 requests, all HTTP 429. Diagnostic: 1 request, HTTP 200. G1 retry: 1 grounded request, HTTP 200. G2: 75 grounded requests, all HTTP 200 |
| Backups | The previous `.env` was backed up locally. Secret files stay out of git |

## 11. Final report

| Gate | Result | Evidence | Next action |
|---|---|---|---|
| G1 Live | PASS | Check `7b7dccd6…`, digest `8073697f…`, `PROVIDER_GROUNDING`, 4 citations | None. G1 is complete |
| G2 Evidence | PARTIAL_COHORT | 75 of 105 samples, 75 grounded, 0 failed, 0 reviewed. Section 4 | Operator reviews 75 observations |
| G3 Delivery | BLOCKED | No authorized customer | Confirm one agency and one client |
| G4 Repeat | NOT_STARTED | Depends on G3 | Record one real action, then re-check |
| G5 Payment | BLOCKED | No customer, no offer sent | Confirm and send the offer |

Questions:

1. Can OpenRecord execute one genuine live observation? Yes. One retrieval-backed
   observation is stored, with citations, raw bytes and a matching digest.
2. Can it find useful discrepancies in real business information? Not known
   yet. 75 grounded observations exist for 15 frozen facts. No human review
   exists, so no discrepancy is confirmed. The early G1 signal did not hold
   against the current first-party source.
3. Can an agency deliver the result to a real client? The product can. No real
   client exists.
4. Does the client or agency use the result? No delivered record exists.
5. Does the customer request another check? No.
6. Has anyone paid? No.
7. What work is still manual? The agency changes its own website and content.
   The operator judges every answer. The reviewer confirms every finding. The
   operator sends the link. A person merges any fix branch.
8. Which engineering changes are genuinely necessary? None for this blocker.
   One candidate evidence-semantics defect is recorded for review.

Product verdict: `LIVE_PRODUCT_VERIFIED`

The highest milestone with genuine evidence is live product verification. 76
real, retrieval-backed observations are stored: 1 from G1 and 75 from G2. No
human judgment, confirmed finding, customer, or payment exists. G3 to G5 are
not validated.

The smallest next step: the operator reviews the 75 G2 observations. Precision
and evidence cards come only after that review.
