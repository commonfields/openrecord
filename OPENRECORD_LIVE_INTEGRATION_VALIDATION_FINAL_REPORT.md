# OPENRECORD_LIVE_INTEGRATION_VALIDATION_FINAL_REPORT

Milestone: W7 (GitHub-connected execution) and W8 (authenticated GA4 measurement) validated against real authorized providers, plus full-workflow acceptance and correctness fixes.
Date: 2026-10-22/23. Executor: principal product engineering session (autonomous, with explicit user authorization for GitHub sandbox and merge actions).

## 1. Starting and ending SHA

| | SHA | Note |
| --- | --- | --- |
| Starting `main` | `5ebaa8151635321e96f03769749c0312f8a4547e` | identical to the last-verified W8 main (PR #73); no upstream drift existed |
| Working tree | isolated worktree off `origin/main` at `5ebaa815` | the checkout in `/Users/wira/Documents/openrecord` was a dirty unrelated branch and was left untouched |
| Ending branch | `fix/integration-validation-findings-v1` @ `b9ad11e` → **PR #74** | three commits: GA4 zero-day semantics, fresh-clone migration rehearsals, hermetic test counts |

## 2. Environment and configuration readiness

- Node v24.3.0 (nvm; engine requirement `>=24 <25` satisfied), pnpm 10.12.1, Python 3.11.6.
- PostgreSQL 16 via `postgres:16-alpine` Docker containers (host PG is 14 and was not used); dedicated disposable databases for tests, migrations, W6 acceptance, and the live run.
- Repository `main` had **no** provider configuration (`.env` absent; no `GITHUB_EXECUTION_*`, no `GOOGLE_OAUTH_*`/`GA4_*` anywhere in the environment) — consistent with W8's fail-closed design (`Ga4NotConfigured`, `RepositoryNotPermitted` verified live, see §4 L.01 preconditions and §5).
- Authorizations available: a disposable GitHub repository was created for this milestone under the user's account with the user as merging maintainer (explicitly authorized). No Google OAuth client or GA4 property was available (user-confirmed) → `LIVE_GA4_BLOCKED`.

## 3. Exact real-provider operations attempted

1. GitHub REST (real `api.github.com`, user's account, disposable repo `wiramahendra/openrecord-w7-live-sandbox`): repository read, branch head read, file read, one branch create, one commit, one PR open, PR reads — exactly the `GitHubTransport` boundary; then one maintainer merge via `gh` CLI (outside OpenRecord), Pages enablement for the live-site check, and independent content reads.
2. Google Analytics: **none attempted against the real API** — no OAuth client/property available. All GA4 work is mock/fixture-backed plus documentation-grounded semantics work (§6). Nothing was fabricated.

## 4. GitHub validation results — `LIVE_GITHUB_PASS`

Driven over HTTP against the built API and worker with a real token; the operator steps (approve, authorize, dispatch) were performed by the operator session with the user's authorization; the merge was the authorized maintainer's action. Checks L.01–L.12 executed by the live driver; L.13–L.17 verified against the settled state and local tree.

| # | Check | Result |
| --- | --- | --- |
| L.01 | Connect the authorized disposable repository to the test business | LIVE_PASS |
| L.02 | Initiative approved by an operator | LIVE_PASS |
| L.03 | Exact change prepared from the real GitHub page at the base revision (diff contains the real `noindex`) | LIVE_PASS |
| L.04 | Human authorization recorded, bound to the exact patch hash (24 h expiry) | LIVE_PASS |
| L.05 | Dispatch through the real GitHub API: exactly one open pull request | LIVE_PASS |
| L.06 | PR targets the authorized repository, base `main`, deterministic head `openrecord/exec-<operation id>` | LIVE_PASS |
| L.07 | An open PR is not recorded as merged (no receipt while open) | LIVE_PASS |
| L.08 | Another account cannot see the operation (404, tenant isolation) | LIVE_PASS |
| L.09 | The authorized maintainer merged PR #1 (via `gh`, outside OpenRecord; OpenRecord never merges) | LIVE_PASS |
| L.10 | Reconciliation verified the real merge from provider evidence into exactly one `SYSTEM_VERIFIED / PR_MERGED` receipt | LIVE_PASS |
| L.11 | sha256 of the file at the real merge commit equals the stored approved `after_sha256` (approved bytes = merged bytes) | LIVE_PASS |
| L.12 | Evidence: exactly one `BRANCH_READY`, one `COMMIT_CREATED`, one `PR_OPENED`, one `PR_MERGE_CONFIRMED` | LIVE_PASS |
| L.13 | Retrying reconciliation duplicates nothing | PASS — see note |
| L.14 | Initiative shows the `SYSTEM_VERIFIED` execution with claim `PR_MERGED`; initiative still `APPROVED` | PASS |
| L.15 | Live website observation recorded separately (see §5) | PASS |
| L.16 | A receipt cannot be forged through SQL (guard: "execution system claim unverified") | PASS |
| L.17 | The credential appears nowhere in the local tree (grep over apps/packages/temp) | PASS |

Evidence chain recorded in `growth_execution_events` for operation `f9a25e08…`: `PREPARED → AUTHORIZED (expiresAt 2026-10-23T19:44:56Z) → DISPATCHING → AWAITING_MERGE (prUrl …/pull/1) → RECONCILING (mergeObserved, mergeCommitSha f6c58896…) → VERIFIED (interventionId 861608b5…)`. Jobs: `DISPATCH DONE`, `RECONCILE DONE`, `LIVE_CHECK DONE`. Branches after: exactly `main` + the deterministic exec branch — no stray writes.

**L.13 note (honest split).** A repeated `POST /check` on the settled operation is refused (`TransitionRefused`) — the lifecycle enforces finality rather than re-reconciling. Duplication is impossible structurally (partial unique indexes allow exactly one `PR_OPENED` and one `PR_MERGE_CONFIRMED` per operation; receipt counts stayed at exactly 1 across all later reads), and the worker's crash-recovery/replay idempotency (dispatch replay, reconcile replay after the receipt) is covered by `apps/worker/src/execution.integration.test.ts` against a provider stand-in (`MOCK_PROVIDER_PASS` for that specific path). The live run proved one real dispatch → one real PR → one receipt; it did not exercise a second live reconcile cycle.

**Precondition behavior verified live:** with no provider configured, connecting a target is refused `RepositoryNotPermitted`; the database additionally refuses a repository already connected to another account ("repository is connected to another account" — observed while iterating on disposable test accounts) and refuses `commonfields/openrecord` unconditionally.

## 5. Live website observation — `LIVE_SITE_PASS`

Separate from the merge, as W7 §9 requires:

1. Before deployment: the registered live URL was unreachable → live check recorded `INCONCLUSIVE` ("network error") and the operation stayed `VERIFIED` — an unobservable site is never success.
2. GitHub Pages was enabled on the disposable repo (user-authorized), built, and `…/pricing.html` returned HTTP 200.
3. A new operator-requested live check produced `CHANGE_OBSERVED` — "The live page no longer carries a noindex directive" (checked_at 2026-10-22T23:23:51Z).
4. Independent verification: `curl` of the live page shows no `noindex` occurrence and the exact approved content.

A GitHub merge and this page deployment remain evidence of the change being live — not of business impact (that belongs to W3/W4 measurement).

## 6. GA4 OAuth and measurement results — `LIVE_GA4_BLOCKED` (with a code-level edge-case finding and fix)

**Blocked prerequisite:** no Google OAuth client (`GOOGLE_OAUTH_CLIENT_ID/SECRET`), no `GA4_TOKEN_ENCRYPTION_KEYS` deployment key, no accessible GA4 test property, and no Google account authorization available in this environment (user-confirmed). Per the mission, missing credentials are blockers, not reasons to fabricate evidence. Exact next authorized action: create/select a Google Cloud project with an OAuth **web** client (redirect URI `<APP_BASE_URL>/api/growth/ga4/oauth/callback` registered, Analytics Admin API + Data API enabled, consent screen with `analytics.readonly`), provide the four `GOOGLE_OAUTH_*`/`GA4_*` variables plus a GA4 property the authorizing identity can read, and complete one interactive consent. No secrets should be shared in chat; set them in the deployment environment.

What was verified without live access (all `MOCK_ADAPTER_PASS`, per W8 §11): OAuth request shape/PKCE/state single-use, scope refusals, identity checks, credential sealing (AES-256-GCM envelope, AAD binding, plaintext refused by DB), binding guards, provenance (CSV route cannot claim `AUTHENTICATED_PROVIDER_API`; deferred trigger refuses an authenticated import without an observation), idempotency, revisions, conflicts, refresh/suspension, disconnect revocation, and no-secret redaction — package tests, DB/API/worker integration tests, and the W8 runtime smoke over HTTP with an independent stand-in.

### Zero-versus-missing GA4 findings (the critical edge case)

**Finding.** Google's `runReport` reference states: *"Regardless of this `keepEmptyRows` setting, only data recorded by the Google Analytics property can be displayed in a report. For example if a property never logs a `purchase` event, then a query for the `eventName` dimension and `eventCount` metric will not have a row eventName: "purchase" and eventCount: 0."* Under documented semantics, a day with zero occurrences of the selected key event produces **no row** — not an explicit zero. The previous implementation (and the local fixture's seeded-zero path) treated absent days as `MISSING`, which would make W4 report `MISSING_DAYS` for any window containing a zero day — i.e., permanently indeterminate for realistic low-volume key events. That is the "unnecessarily indeterminate" outcome the mission anticipated, and it is fixed in PR #74.

**The fix (grounded in the documented semantics, robust under both possible real behaviors):**

- For every requested day with no key-event row, the sync reads one unfiltered property-activity report (dimensions `date`, metrics `eventCount`, same window, `keepEmptyRows`).
- Proven recorded activity that day (eventCount ≥ 1) + no key-event row → **authoritative zero**, recorded with the derivation listed in the observation evidence (`derivedZeroDays`) and the probe's own normalized answer stored (`activity`). Explicit `"0"` rows keep their direct reading.
- No recorded property activity → day stays absent (`MISSING`/`UNAVAILABLE`). **Missing is still not zero.**
- Derivation is never attempted from a suspect answer: if the filtered report is thresholded, or the activity probe is sampled / data-loss / thresholded / malformed / refused, the probe is recorded as skipped (`activitySkipped`) and those days stay absent. Incomplete responses are refused before recording (unchanged).
- Provenance separation preserved: derived zeros exist only in the authenticated sync path; operator exports and synthetic fixtures are untouched; historical revisions and the observation/provenance model are unchanged (no migration needed — the evidence envelope is opaque to the DB guards).
- Idempotency: a later explicit `"0"` row for a previously derived day is the same answer → `UNCHANGED` (no duplicate import).

**Test evidence (mock, labeled):** `packages/ga4/test/ga4.test.ts` (parser refusals; derivation only from clean probes; thresholded answers never derive; silent days stay absent), `apps/worker/src/ga4-sync.integration.test.ts` (end-to-end: derived zero recorded as `OK/REAL/GA4_DATA_API` while a no-activity day stays `MISSING`; thresholded + sampled-probe skips recorded; repeat sync → `UNCHANGED`), W8 runtime smoke green. `LIVE_GA4` confirmation of the derivation against a real property remains the outstanding step after the blocker above is resolved.

## 7. Full workflow acceptance results

- **Live-path acceptance (W7 chain):** initiative → approval → exact-change preparation → human authorization → real GitHub dispatch → one PR → maintainer merge → provider-verified `SYSTEM_VERIFIED / PR_MERGED` receipt → live-site observation, all verified against real providers (§4/§5). The W4 measurement leg of the live chain was not exercised because GA4 is blocked; the operator-attested/measurement legs are covered below.
- **Fixture-backed end-to-end acceptance (labeled separately, `MOCK_PROVIDER_PASS`):** W6 acceptance driver **87/87 checks** — business/goal/metric creation, initiative approval, attested execution, CSV imports, evaluation comparability rules, plan-declaration honesty, report preview/publication, immutable snapshots, share + revocation, idempotent retries, linear version chains, DB immutability — run twice (before and after the fixes).
- **Runtime smokes over built API/worker (mock providers, HTTP):** hosted, agency-record, connected-execution (W7), GA4 measurement (W8) — all pass, run twice.
- Observation-window honesty: W6/W4 fixtures keep incomplete windows indeterminate (`OBSERVATION_INCOMPLETE`); no synthetic evidence was published as a real outcome anywhere; no actions or plan declarations were backdated.

## 8. Test results and migration integrity

- Typecheck, lint, build: clean on `main` and on the PR branch.
- Full workspace tests (PG16): db 259 passed, worker 117, api 301, ga4 22, web 111, site-operator 45, providers 45, discovery 99, representation 202, truth 40, protocol 31, domain 11, config 8, contracts 19 — all green on the final tree (some suites skip without `TEST_DATABASE_URL` by design; integration opt-in was used).
- Migration rehearsals (fresh + replay + populated-upgrade + refusals), all with catalog SHA `291104d944ef8d57…`:
  - W0 ✓, W3 ✓, W5 ✓, W7 ✓, W8 ✓ (W0/W3 required the fresh-clone fix in §9; the historical `0031` commit `ee80b911` is unrecoverable — deleted upstream, absent from every ref and the local object store; the scripts now record `legacy0031Source`).
  - `0031` was never replayed (preserved-artifact refusals verified in every rehearsal).
- CI on PR #74: Rust CLI job passed; hosted job (typecheck/lint/tests/builds + four smokes) ran to completion — status recorded at merge time.
- Pre-existing flakiness found and fixed (§9c); one worker-side flake (a GA4 sync job occasionally left `QUEUED` for one runner pass under full-suite load) was observed once and not reproduced in 5+ subsequent full runs — noted for future investigation, no change made.

## 9. Defects found and fixes applied (PR #74, branch `fix/integration-validation-findings-v1`)

1. **GA4 zero-day semantics (measurement correctness).** Absent key-event rows resolved as `MISSING`, making W4 indeterminate for any zero-activity day. Fix: activity-probe-derived zeros with conservative refusal paths, as described in §6. Files: `packages/ga4/src/report.ts`, `packages/ga4/src/fixture.ts`, `apps/worker/src/ga4-sync-runner.ts`, tests, smoke stand-in, W8 doc §4/§6/§11.
2. **W0/W3 migration rehearsals unrunnable from a fresh clone (validation gate blocker).** Hard dependency on the unreachable historical commit `ee80b911`. Fix: prefer the preserved object, fall back to synthesized legacy-0031 markers, record the source in the summary.
3. **Flaky read-only assertions (test isolation).** `growth-report` / `growth-evaluation` integration tests counted shared-table rows globally while other files ran in parallel on the same database; fixed by scoping counts to the fixture business.

No product contracts were changed beyond the W8 doc amendment in (1); no migration files were added or modified; evidence immutability, report snapshots, and the migration lineage are intact (rehearsal catalog SHA identical across W0–W8).

## 10. Blockers requiring human authorization

| Gate | Missing prerequisite | Exact next authorized action |
| --- | --- | --- |
| `LIVE_GA4_PASS` | Google OAuth web client + Analytics APIs enabled + registered redirect URI + an accessible GA4 test property + one interactive consent | Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GA4_OAUTH_REDIRECT_URI`, `GA4_TOKEN_ENCRYPTION_KEYS` in the deployment environment; then rerun the OAuth connection, property listing/binding, backfill, duplicate-sync idempotency, refresh/revocation, and the zero/missing probe confirmation of §6. Do not send secrets through chat. |
| `LIVE_SITE_PASS` (generalization) | This pass is bound to the disposable sandbox site (GitHub Pages). A customer-domain observation requires a registered customer website | For the pilot, register the real business site and repeat L.15's live-check flow against it |
| Sandbox cleanup | The disposable repo `wiramahendra/openrecord-w7-live-sandbox` (public, TEST content only) served its purpose | Delete it (or keep as evidence; contains no secrets or customer data) |

## 11. Operator pilot readiness assessment

**Engineering readiness: strong.** All gates are green; the connected-execution workflow is proven end-to-end against real GitHub with exactly-once evidence and correct refusal behavior at every guard; the live-site observation behaves honestly in both directions (INCONCLUSIVE before deployment, CHANGE_OBSERVED after); the GA4 measurement path is mock-verified with the zero-day flaw fixed pending live confirmation.

**Real operator acceptance: not yet demonstrated.** No human operator has driven the product UI for a real business decision in this milestone (the driver performed the operator API calls under authorization), and the GA4 leg lacks live provider validation. Distinguishing the two: the remaining risk is concentrated in (a) GA4's real OAuth/consent UX and real-API response shapes (documented semantics ≠ guaranteed behavior until observed), and (b) the operator's real-world judgment workflow, which no synthetic acceptance can establish.

## 12. Final verdict

| Gate | Result |
| --- | --- |
| `MOCK_PROVIDER_PASS` | **PASS** (all suites, migrations, W6 87/87, four runtime smokes) |
| `LIVE_GITHUB_PASS` | **PASS** (real API dispatch → merge → verified receipt → byte-identical merged content; forged evidence refused) |
| `LIVE_SITE_PASS` | **PASS** (deployed sandbox page observed `CHANGE_OBSERVED`; undeployed state honestly `INCONCLUSIVE`) |
| `LIVE_GA4_PASS` | **BLOCKED** (no authorized Google OAuth client / GA4 property; mock-verified only, zero-day fix pending live confirmation) |
| `FULL_WORKFLOW_PASS` | **PASS (fixture-backed)** for the complete W0–W5 chain; **PASS (live)** for the W7 execution chain; the live W8 measurement leg is the open item |

**Overall verdict: `PARTIAL_LIVE_VERIFICATION`.**

GitHub-connected execution and live-site observation are verified against real authorized providers with trustworthy, exactly-once evidence. GA4 remains blocked on an authorized Google OAuth client and test property; the documented-semantics fix for the zero-vs-missing edge case is implemented and mock-validated but awaits live confirmation. A passing CI run establishes neither; both claims above carry their own supporting evidence as listed. The disposable GitHub sandbox repo remains available as evidence and can be deleted after review.
