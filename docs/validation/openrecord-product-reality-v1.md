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

G1 is `PASS`. G2 awaits operator approval, because the operator limited this
execution to one smoke test. G3 to G5 did not start. Preparation work for G2,
G3 and G5 is complete. No customer, review, or payment was invented. No
engineering change was necessary.

## 1. Starting state

| Item | Value |
|---|---|
| Repository | `commonfields/openrecord` |
| Starting SHA | `6a37ea46abea458e3de037c03371d0c4c9e5fa01` |
| Working tree | Clean |
| PR #49 (`OPENRECORD_RECORD_INTEGRITY_V1`) on main | Yes. Merge commit `decb5fe` |
| PR #51 (product map STE100 v1) on main | Yes. Merge commit `6a37ea4`. File `docs/product/openrecord-product-map-ste100.md` present |
| Branch for this work | `docs/openrecord-product-reality-v1` |

Verification commands: `git log --oneline -3 origin/main` and
`git cat-file -e origin/main:docs/product/openrecord-product-map-ste100.md`.

## 2. Acceptance gates

| Gate | State | Evidence | Human dependency | Next action |
|---|---|---|---|---|
| G1 Live execution | PASS | Observation stored with `PROVIDER_GROUNDING`; check run `7b7dccd6…`; digest `8073697f…` | None. Paid-tier access is active | None. G1 is complete |
| G2 Evidence quality | BLOCKED | G1 passed. Cohort prep below | An approved budget of $5 and real reviewer decisions | Ask the operator to authorize G2, then sample 105 times |
| G3 Product delivery | BLOCKED | No authorized customer | One real agency and one real client | Confirm a customer, then deliver |
| G4 Repeat value | NOT_STARTED | Depends on G3 | Agency action and a second check | Start after G3 passes |
| G5 Payment | BLOCKED | No customer, no offer sent | Operator confirms the offer | Send the offer after approval |

G2 is blocked only by an approval, not by a defect. The operator stopped the
work after one smoke test on purpose.

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
Source: `apps/api/src/record-routes.ts` (`startRun`, `requestedModel: surface.model`).
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
| Business | `2183713a-7ec0-483f-9a3d-ec3d18bd8b93` |
| Record run | `9d2f2d7b-c59c-416e-bd28-d3e8921235c3` |
| Check run | `d91577be-9de6-479e-b481-613d5619754e` |
| Requested model | `gemini-3.5-flash-lite` |
| Run status | `FAILED` |
| Failure class | `PROVIDER_RATE_LIMITED` |
| Provider status | HTTP 429 |
| Provider body | "You exceeded your current quota, please check your plan and billing details." Status `RESOURCE_EXHAUSTED` |
| Attempts | 4, all HTTP 429 |
| Attempt evidence | 1,234 bytes per attempt, digest `8de9461ae629ada766d5286342cde59bbe8f2680fe0ea604463983c4e67e5757`, content type `application/json; charset=UTF-8` |
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

Command: `node /tmp/or-smoke-retry.mjs`. The script signs in, starts one
`INITIAL` run through the HTTP API, and polls the operator view.

The check succeeded. Every acceptance item below is verified against stored
evidence, not against the provider response alone.

| Acceptance item | Result |
|---|---|
| Request succeeded | Yes. Check status `SUCCEEDED`; the worker logged "check succeeded" |
| Correct model answered | Yes. Requested model and observed model are both `gemini-3.5-flash-lite` |
| Response has grounding metadata | Yes. `retrieval_requested = true`, `retrieval_observed = true`, `retrieval_mode = PROVIDER_GROUNDING` |
| Retrieval tool recorded | Yes. `retrieval_tool = google_search`, with 2 web search queries stored |
| Raw response stored | Yes. 9,499 bytes, content type `application/json; charset=UTF-8`, limit 2,097,152 bytes |
| Evidence digest stored | Yes. Digest `8073697fe968cc518b352f137ec69219dd9dea0501b1785b4084ad32100720ae` |
| Digest matches the stored bytes | Yes. `observation.raw_digest = raw_evidence.digest` |
| Citations preserved | Yes. 4 citations, all attributed. Hosts: `loewshotels.com` twice, `airportparkingreservations.com`, `parksleepfly.com` |
| Observation is not synthetic | Yes. `synthetic = false` |
| No provider substitution | Yes. Provider `gemini`; requested model equals observed model |
| Public evidence rules intact | Yes. 0 shares. 0 judgments. An unreviewed answer is not public |

| Field | Value |
|---|---|
| Business | `2183713a-7ec0-483f-9a3d-ec3d18bd8b93` |
| Record run | `7300c4b3-f2c3-42e1-9687-432b98311295` |
| Check run | `7b7dccd6-38e5-4099-ad37-630bf37c02af` |
| Run status | `SUCCEEDED` |
| Observations stored | 1 |
| Answer text | "Yes, the Loews Chicago O'Hare Hotel runs a complimentary airport shuttle service to and from Chicago O'Hare International Airport (ORD)." |
| Token use | 23 input tokens, 161 output tokens, 184 total |
| Service tier | `standard` |
| Finish reason | `STOP` |

The answer states a shuttle frequency, "every 15 minutes". The first-party page
in section 4 does not state that frequency. The answer cites `loewshotels.com`.
This is an observation for the reviewer. This document does not judge it.
Section 6 holds the rule: only a human decides.

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

Authorization needed to continue: approve the G2 budget of $5 for the frozen
cohort. The project now has grounding access. A billing alert is not a hard
spending limit, so set a hard cap too.

Approval request, ready to send:

| Item | Value |
|---|---|
| Cohort | 7 businesses, unchanged, from `docs/validation/record-integrity-real-business-v1.md` |
| Facts | 3 per business, 21 total |
| Buyer questions | 3 per business, 21 total |
| Samples per fact | 5 |
| Planned samples | 105 |
| Retries | No selective retries. Every failed sample stays in the denominator |
| Stop rule | Report the precision ledger at 3 of 7 businesses with promising yield |
| Budget | $5. Normal case about $0.30 |
| Model | `gemini-3.5-flash-lite`, `google_search` grounding |

## 4. G2 — Evidence quality

State: `BLOCKED_AWAITING_AUTHORIZATION`. The operator limited this execution to
one smoke test. G2 did not start. No cohort spend.

Safe preparation is complete. First-party pages were fetched on 2026-10-17.

| ID | Business | Fact checked against the first-party page | Source URL | Verified on 2026-10-17 |
|---|---|---|---|---|
| VB-01 | Loews Chicago O'Hare | Pet fee $120 per stay | `https://www.loewshotels.com/chicago-ohare` | Confirmed |
| VB-01 | Loews Chicago O'Hare | Complimentary airport shuttle exists | same | Confirmed, but the page does not state "every 15 minutes, 24/7". That frequency needs a different first-party source |
| VB-01 | Loews Chicago O'Hare | Check-in 4 PM | same | Confirmed. The cohort draft said 3 PM |
| VB-02 | Hotel Edison NYC | Check-in 3:00 PM, check-out 12:00 PM | `https://www.edisonhotelnyc.com/faqs` | Confirmed |
| VB-02 | Hotel Edison NYC | Cancellation varies from 24 hours before arrival to non-refundable | same | Confirmed |
| VB-03 | GoCare Urgent Care Newark | Saturday hours 8:00 AM to 6:00 PM | `https://gocaredelaware.com/` | Confirmed |
| VB-03 | GoCare Urgent Care Newark | X-ray available | same | Confirmed |
| VB-03 | GoCare Urgent Care Newark | Walk-in, no appointment | same | Confirmed |
| VB-04 | Urgent Care Plus Wilmington | Sports and work physicals $45 | `https://urgentcareplusmd.com/` | Confirmed |
| VB-04 | Urgent Care Plus Wilmington | TB/PPD testing $35 | same | Confirmed |
| VB-04 | Urgent Care Plus Wilmington | X-ray on site | same | Confirmed |
| VB-05 | Amazon | Return window and free returns | `https://www.amazon.com/gp/help/customer/display.html` | Not verified. The help page is script-rendered |
| VB-06 | At Home | Receiptless returns, 60 days | `https://help.athome.com` | Not verified. The site answered HTTP 403 and 410 |
| VB-07 | Target | General return window 90 days | `https://www.target.com/help/article/returns` | Not verified. The help page is script-rendered |

Every fact keeps the label `PUBLIC_SOURCE_UNAPPROVED`. No business approved
these facts. No business was contacted.

Two facts need a wording change before the freeze: the Loews shuttle frequency,
and the Loews check-in time. Both changes come from the current page.

Reviewers must supply every judgment. The agent prepares a queue only. The
review protocol is in `docs/validation/record-integrity-real-business-v1.md`.

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
`packages/db/src/record-view.test.ts` line 170.
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
| Price | $300 per client per month. This is a hypothesis, not a market price |
| Pilot total | $900 for the pilot period, subject to operator confirmation |
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
Source: `packages/db/src/evidence.ts` line 826. The record read path selects the
stored flag directly. Source: `packages/db/src/record.ts` line 444. No record run
holds these rows today, so the product cannot misreport them now.

Fixing this would change evidence semantics. The task forbids that without
authorization. No code was changed in this execution.

## 10. Environment changes

| Change | Detail |
|---|---|
| `.env` | `GEMINI_MODEL` changed from `gemini-2.5-flash` to `gemini-3.5-flash-lite`. `GEMINI_API_KEY` replaced by the operator with a paid-tier key. This document does not print or store the secret |
| API | Stopped and restarted with Node 24.3.0. Listening on port 3001 |
| Worker | Two worker instances were running. Both stopped. One worker restarted with Node 24.3.0 |
| Web | Left running on port 3000 |
| Database | Not changed. No volume deleted. No migration added. 0 shares. 0 judgments |
| PostgreSQL 14 (Homebrew) | Not touched |
| Provider calls | First attempt: 4 requests, all HTTP 429. Diagnostic: 1 request, HTTP 200. Retry: 1 grounded request, HTTP 200 |
| Backups | The previous `.env` was copied to a local temporary file. The secret file stays out of git |

## 11. Final report

| Gate | Result | Evidence | Next action |
|---|---|---|---|
| G1 Live | PASS | Check `7b7dccd6-…`, run `7300c4b3-…`, digest `8073697f…`, `PROVIDER_GROUNDING`, 4 citations | None. G1 is complete |
| G2 Evidence | BLOCKED | G1 passed. Cohort prep table above | Authorize $5, freeze corrected facts, then sample 105 times |
| G3 Delivery | BLOCKED | No authorized customer | Confirm one agency and one client |
| G4 Repeat | NOT_STARTED | Depends on G3 | Record one real action, then re-check |
| G5 Payment | BLOCKED | No customer, no offer sent | Confirm and send the offer |

Questions:

1. Can OpenRecord execute one genuine live observation? Yes. One retrieval-backed
   observation is stored, with citations, raw bytes and a matching digest.
2. Can it find useful discrepancies in real business information? Not tested.
   G2 did not start. One early signal exists: the answer states a shuttle
   frequency that the first-party page does not state.
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

The highest milestone with genuine evidence is live product verification. One
real, retrieval-backed observation is stored. No discovery result, customer,
review, or payment exists.

The smallest next step: authorize the G2 budget of $5 for the frozen cohort.
Then freeze the two corrected Loews facts and start sampling.
