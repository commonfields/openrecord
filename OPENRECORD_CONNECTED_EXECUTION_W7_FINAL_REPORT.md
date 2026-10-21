# OpenRecord connected execution (W7) — final report

All provider behavior verified in this milestone is **modeled** (an in-memory
fixture and a local GitHub stand-in over HTTP). No real GitHub repository, no
live credentials and no live website were used. Nothing here is customer
evidence.

## 1. Repository

| Item | Value |
| --- | --- |
| Starting `origin/main` | `7d0c0b7a899f26062b5ae388ec7df795cf069f09` (verified by fetch) |
| Worktree / branch | `/Users/wira/openrecord-wt-w7`, `feat/connected-execution-w7-v1` |
| W2 work | Found locally: commit `ee80b91` on `feat/growth-github-delivery-v1` and `archive/growth-p2-ee80b91`. **Left untouched, not merged.** Reused: the GitHub REST transport, blob-sha comparison, one-branch/one-commit/one-pull-request flow, repository allowlist parsing, fixture-provider pattern, line diff. Not carried over: its migration `0031`, `IN_DELIVERY`/`DELIVERED` initiative states, `delivery_id`, `VERIFIED_ACTION` evidence, operator-attested deployment, Markdown-only paths. |
| Migration | `0034_growth_connected_execution_v1.sql` (additive; `0031` never replayed) |
| Final SHA, PR, merge | Recorded in the hand-off message: a report inside the PR cannot contain its own merge SHA. |

Files (new unless noted):

- contracts: `growth-execution.ts` (+test), `index.ts` (export), `growth-report.ts` (client page no longer names a customer repository for a verified merge)
- site-operator: `src/github.ts` (+`test/github.test.ts`), `src/index.ts`
- db: migration `0034`, `src/growth-execution.ts` (+integration test), `src/growth-repositories.ts`, `src/growth.ts` (initiative final decision refuses while execution is unresolved), `src/index.ts`
- api: `src/growth-execution-routes.ts` (+integration test), `src/router.ts`, `src/server.ts`
- worker: `src/execution-runner.ts` (+integration test), `src/runner.ts`
- web: `components/growth-execution.tsx`, `lib/growth-execution.ts`, `routes/client-growth.tsx`, `lib/growth.ts`, `lib/growth-report.ts` (wording), tests
- scripts and CI: `verify-marketing-w7-migrations.py`, `connected-execution-runtime-smoke.py`, `.github/workflows/ci.yml`
- docs: `docs/engineering/connected-execution-w7.md`, runbook section 13

## 2. Architecture

Full contract: `docs/engineering/connected-execution-w7.md`. Summary:

- **Three facts, kept apart.** Request accepted (events, `PR_OPENED`). Provider action verified (`PR_MERGE_CONFIRMED` + one `SYSTEM_VERIFIED / GROWTH_DELIVERY / PR_MERGED` intervention linked to the initiative). Live change observed (separate append-only checks). Business impact is never derived. A merge is never `SOURCE_PUBLISHED`.
- **Own lifecycle.** `PREPARED, AUTHORIZED, DISPATCHING, AWAITING_MERGE, RECONCILING, VERIFIED, FAILED, BLOCKED, UNKNOWN, CANCELLED` in `growth_execution_events`. The initiative's human lifecycle gained no states or columns.
- **Authority.** Only a person authorizes, dispatches, cancels. Only the execution system records provider facts. The assistant has no route or tool; a test asserts the tool names. Authorization binds a patch hash over repository, base branch, base commit, page, live URL and before/after bytes, and expires after 24 hours.
- **Adapter boundary.** One GitHub transport: read repository, branch head, file, pull request and its files; create one branch, one commit, one pull request. No merge, no deployment. Credentials from server configuration only; per-account allowlist; OpenRecord's own repository refused in contract, API, worker and database.
- **Durable orchestration.** A job table (`DISPATCH`, `RECONCILE`, `LIVE_CHECK`), one open job per operation and kind, `SKIP LOCKED` claims with leases, a repair pass for operations that lost their job. **Read before write**: a replay after any crash reaches the same branch, commit and pull request.
- **Retries.** Provider `Retry-After`, then exponential backoff 15 s to 10 min, at most 5 dispatch attempts; a write with unknown outcome is reconciled before anything is written again; 401/403/404/validation failures are permanent; three unknown cycles end in `BLOCKED`; an unmerged pull request is followed for 30 days.
- **What `PR_MERGED` verifies.** Same pull request, repository, base and head branch; head unchanged since opened; merged with a 40-hex commit and time; exactly one file changed, the authorized page; that page at the merge commit has exactly the approved blob and sha256. Any mismatch stops the operation with no receipt.
- **Database enforcement.** `growth_execution_verified(interventions)` keeps its W0 signature and now checks the full claim; no overload, no flag; one receipt per operation. Evidence guards refuse contradicting merge evidence. Operations, events, evidence and live checks are append-only. The database cannot know provider truth: the worker holding the credential establishes the evidence, and direct database write access remains a trust boundary.
- **Live site.** Shared SSRF-safe fetch scoped to the registered site, classified by the existing inspector: observed, not observed, inconclusive, or pending. It never changes the operation state.

## 3. Verification

Node 24.3, PostgreSQL 16, pnpm 10.12.1.

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` | all exit 0 |
| Tests | **1,318** (baseline `7d0c0b7`: 1,269; **+49**): api 293, web 106, worker 101, db 257, representation 202, discovery 99, fs-containment 61, site-operator 45, providers 45, truth 40, protocol 31, contracts 19, domain 11, config 8 |
| Remote CI | recorded in the PR |

New tests: db 11 (guards, direct-SQL forgery, replay, tenancy, claims, idempotency, races), worker 14 (all scenarios below), api 5 (HTTP authorization and exact change), contracts 7, site-operator 8, web 4.

**Migration rehearsal** (`scripts/verify-marketing-w7-migrations.py`, new databases, nothing reset): fresh install and replay; pre-`0034` lineage with fixture rows upgrades and replays with an identical catalog; a populated database (430 operations, 84 receipts) replays byte-identical; after a **full replay** the verification function still checks merge evidence and the initiative guard still holds the unresolved-execution refusal; a hand-forged receipt is refused; the old `0031` marker (column or old tables) is refused by `migrate()` and by `0034` alone, before any W7 object exists. The W5 rehearsal still passes.

**Scenario A (success).** An inspector-classified `BLOCKED_BY_META` finding; exact patch; authorization; one branch, one commit, one pull request (writes asserted, base branch untouched); open and unmerged stays unverified however often polled; merge by the fixture maintainer; one `SYSTEM_VERIFIED / PR_MERGED` receipt linked to the initiative which stays `APPROVED`; ledger shows the exact claim and never `SOURCE_PUBLISHED`; live site separately `NOT_OBSERVED`, later `OBSERVED`, then `INCONCLUSIVE` when unreachable or 404; W4 evaluation and W5 preview carry the verified-merge distinction.

**Scenario B (ambiguity).** Timeout after the pull request was created is reconciled (one pull request). Timeout after the commit resumes with no second commit. Stuck outcome ends `BLOCKED`. 401, 404 permanent. Rate limit delays the job by the hint and recovers. 5xx backs off, exhaustion fails closed with nothing written. Closed unmerged, edited, edited-then-merged, extra file, other repository, merge with no commit: no receipt. A worker killed mid-write is replaced with no duplicates, including a reconciler killed after the provider merged and one killed after the receipt. Duplicate polling yields one receipt.

**Scenario C (approval and concurrency).** Foreign account and anonymous requests refused on all 10 routes; cross-origin writes refused; stale source, expired authorization, removed allowlist entry and unconfigured provider stop the write; two workers racing write once; a concurrent final decision and dispatch: exactly one wins (4 iterations); final review and cancellation held while delivery is unresolved, in the API and the database, then allowed with the receipt in place.

**Scenario D (live).** A verified merge with the live page still carrying noindex stays `PR_MERGED` verified with the website `NOT_OBSERVED`; unreachable gives inconclusive.

**Scenario E (regression).** The W6 acceptance driver against the new build: 87/87. Full existing suites unchanged. A published report's stored snapshot is byte-identical after later reconciliation.

**Built runtime.** `scripts/connected-execution-runtime-smoke.py` (added to CI) boots the built API and worker with a local GitHub stand-in: 15/15 checks over real HTTP, including the real transport, one pull request, merge verification, receipt forgery refusal and the held final decision.

**Browser.** The operator journey was driven through the real UI against that stack: connect, prepare, review the exact diff, risk and boundary, approve, open the pull request, waiting for merge, the final-review hold message, then "GitHub merge confirmed" with "Website verification unavailable" on its own line. Driven with scripted DOM events; no screenshots; pixel layout was not inspected.

## 4. Security review

Reviewed and covered by tests: credential leakage (generic errors, header-only, never in responses, evidence, events or logs); SSRF (shared safe fetch, registered-site scope, endpoint must be https or exact loopback); repository escape (allowlist per account, own-repository denial, base-repository and branch checks at merge); branch and path injection (deterministic uuid branch, strict path policy at contract, API, database and worker, encoded URL segments); unbounded retries (attempt cap, backoff ceiling, 30-day merge window, three unknown cycles); approval bypass (hash binding, expiry, state machine mirrored in the database, initiative lock); false verification (full-claim function, evidence guards, forgery tests, replay test).

Findings fixed during the work: a manual website check was shadowed by a delayed automatic one; an operation could be orphaned if a worker died between a state change and the next enqueue (repair pass added); waiting for a merge re-queued non-atomically; an unmerged pull request would be followed forever; the client page would have named a customer's repository.

## 5. Product acceptance

An operator with an approved initiative can now: connect an allowed repository to a registered website, prepare one exact change (remove a robots noindex directive from one HTML page), review the diff, repository, page, risk and boundary, approve exactly that change, send it as a pull request, follow it, ask GitHub or the website to be re-checked, and see three separate statements.

OpenRecord **verifies**: that exactly the approved change was merged into the connected repository, when, and by which merge commit. It **observes separately**: whether the live page still carries a noindex directive. It leaves **unknown**: whether the site was deployed (until observed), whether a search engine indexed the page, and any business result. It does not merge, deploy, retry blindly, or let the assistant act.

## 6. Future adapter boundary

A CMS, listing or email platform reuses the operation lifecycle and guards, the patch-identity authorization, the job table, the receipt contract, the three facts and the initiative hold. It supplies its own exact-change builder, transport, reconcile checks and a claim other than `PR_MERGED` (which needs its own database clause). GitHub specifics stay named as GitHub columns and evidence. No generic connector interface was added.

## 7. Limits and non-goals

No webhooks (polling is the authority), no auto-merge, no deployment, one action, one provider, no agent execution (W9), no measurement connectors (W8). A deployment must set the provider variables and allow repositories per account. The database trusts the worker's evidence. The live check uses the SSRF-safe fetch, which refuses private and unroutable hosts, so a local or private staging site reads as inconclusive.

## 8. Evidence status

| Status | Result |
| --- | --- |
| `MOCK_ADAPTER_PASS` | **Yes.** Fixture provider and local stand-in over HTTP. |
| `LIVE_PROVIDER_PASS` | **Not obtained.** No authorized sandbox repository or credentials were available; no real provider call was made. Blocked on that alone. |
| `LIVE_SITE_PASS` | **Not obtained.** No live site was re-observed after a real operation. In the runtime smoke the live check was inconclusive, as designed. |

To obtain the live statuses an administrator must provide a sandbox repository with a plain HTML page, a fine-grained token, and an `owner/repo=<account id>` allowlist entry, then run the operator journey and merge by hand; the live-site status additionally needs the page deployed at a registered, publicly routable URL.

`W7_IMPLEMENTED_LIVE_PROVIDER_UNVERIFIED`
