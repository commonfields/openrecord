# OPENRECORD_COMBINED_RELEASE_ACCEPTANCE_FINAL_REPORT

**Verdict: `PILOT_RELEASE_READY` — for the verified local Docker release only.**
This does not establish public deployment readiness, customer acceptance, business impact, or live GA4 compatibility.

Date: 2026-10-25.

## Release identity and scope

- Starting main: `8089dd6baa319787421b81e24eb4564cabeb1c40` (PR #76 Product Experience V1, PR #77 report follow-up, and PR #75 Hosted Pilot V1).
- Isolated branch: `release/combined-acceptance-v1`; [PR #78](https://github.com/commonfields/openrecord/pull/78). Runtime fixes: `a51b4a1`; the subsequent evidence-only commit contains this report and screenshots. The final merge SHA is available on the PR.
- Docker project: `openrecord-combined`; PostgreSQL 16 in a new persistent named volume. Regression PostgreSQL 16 uses a separate disposable container on loopback port 56137.
- Browser target: the built Docker/Caddy application at `http://localhost:8086`, not Vite. Host ports 8086 and 8446 are loopback-bound. No external credentials or public deployment.
- The user's live development server on port 3000 and other worktrees are not modified or stopped.

## Demonstrated defects and narrowly scoped fixes

1. Caddy rejects the documented `auto_https on` setting. Removed that non-existent switch: Caddy natively serves `:80` locally and enables automatic HTTPS for a hostname. The new offline proxy gate verifies both configurations without starting a public service or requesting certificates; CI runs it too.
2. Backup verification selected `count(*)` over ten aggregate rows, so it returned `10` regardless of the underlying table counts. It now compares each table's named count, alongside the existing immutable-payload content digest.
3. Hosted smoke claimed cookie security with an unconditional success and claimed revocation without invoking it. It now asserts actual Set-Cookie flags and invokes revoke, then requires anonymous access to return 404. Database isolation now targets the actual Compose project rather than a hard-coded container name.

No frontend files, domain schemas, migrations, provider adapters or marketing features changed.

## Browser acceptance on the containerized application

Method: real headless Chromium (Helium), driven with Playwright `fill`, role/label locators, pointer clicks and navigation against Caddy on port 8086. No Vite, frontend mocks, injected session, direct database evidence inserts, or API-created workflow were used for this browser journey. Signup and every workflow action were submitted through the rendered UI. Subsequent API security probes and queue fault injection are identified separately below.

| Journey | Executed result |
| --- | --- |
| Signup and empty workspace | Account created through the browser; Growth-first Clients page and guided empty state rendered. |
| Onboarding and goal | New client, website, category, audience, value proposition, goal and immutable metric saved through forms. Names and source identity explicitly say TEST. |
| Proposal and approval | Both steps of the proposal completed; a human approval reason submitted; initiative stages displayed. |
| Blocked state | Before recording work, Report stage says: “A report lists recorded actions; record the work first.” Preview itself can display an indeterminate draft; that is not a published outcome. |
| Plan and execution | Four dates declared through the Plan form; Source updated / Website action recorded as operator-attested, not system-verified. |
| Import error | An incompatible CSV was refused with readable GA4-export guidance. |
| Measurement | A labelled TEST GA4-format export imported with 15/15 days reported. No Google connection was required. Source identity and report next steps explicitly disclaim real customer results. |
| Evaluation | Indeterminate with `PLAN_DECLARED_AFTER_EXECUTION`: the test action asserted a historical performed date, whereas its plan was genuinely declared now. Neither declaration nor action ledger timestamps were altered to manufacture comparability. |
| Human decision | Review reason submitted through the browser; initiative becomes Reviewed. |
| Report | Draft preview, client-facing TEST disclaimer, immutable version 1 publication and view-only link creation all completed through the UI. |
| Anonymous access | A separate browser context with no cookies loaded the published report. |
| Revocation | Revoke link clicked in operator UI; the already-open anonymous page reloaded to “Report not available.” It remained unavailable after a full restart. |
| Mobile | At 375×812, Clients, Growth and Measurement had no horizontal overflow; the stage strip was visually inspected in its stacked layout. Public report was also opened at mobile width. |
| Loading and recoverable error | Holding a real profile response exposed the loading skeleton; release of the response restored the workspace. Explicit browser-network HTTP 503 fault injection showed the readable error and Try again recovered after removing the injected fault. This is error-state testing, not provider evidence. |
| Cross-account | A second account signed up through the UI; navigating directly to the first account's Growth workspace showed an error without its initiative/evidence. |

Selected actual rendered captures are committed under [`docs/validation/combined-release-v1/`](docs/validation/combined-release-v1/): empty state, evaluation reasons, published/revoked state, mobile stage strip, anonymous revoked view, loading, retryable error, and cross-account denial. Browser storage-state files and session cookies are not committed.

## Deployment, security and recovery

- All three targets built from the isolated checkout and ran as separate web/API/worker containers with PostgreSQL 16. Caddy serves the production SPA and proxies `/api` on the same origin. The user's changing development UI on port 3000 was never used as release evidence.
- Strengthened hosted deployment smoke: **29 numbered checks passed, zero failures** (the inherited “27 checks” also had P.13a/b; this run adds P.16b for actual revocation). It exercises the API workflow through Caddy, separately from the browser journey above.
- Browser session cookie: HttpOnly and SameSite=Lax; not Secure on local HTTP, as expected. A separate, unexposed instance of the built API configured with an HTTPS application origin returned Secure + HttpOnly + SameSite=Lax. This verifies cookie configuration behind a TLS proxy, not certificate issuance or a public TLS handshake.
- Deployed exact-origin write probe returned HTTP 403 for an untrusted Origin. Cross-account reads returned 404 in deployment smoke and were denied in the actual browser.
- Production mock check-run request returned HTTP 409 / `FixtureProviderDisabled`, with no fixture flags or provider credentials. Authenticated GA4 connection status reported `configured: false`; manual imports, evaluation and reporting remained usable. No live GitHub/GA4 calls were attempted.
- Docker inspection: web ports 8086 and 8446 bound only to `127.0.0.1`; database `5432/tcp` had no host binding. No other services were exposed or modified.
- Readiness returned HTTP 503 with `db: false` while this stack's database was stopped, then recovered to HTTP 200 after restart. Responses exposed no credentials or customer payloads. Deployment log secret scan passed.
- Full-stack restart preserved the browser session, client, initiative, published version and revocation. Both stored report snapshot digests still equal SHA-256 of their snapshot text (`2` reports, all matching).
- Additional worker crash fixture: while the worker was stopped, a TEST check was marked RUNNING with an expired heartbeat. After worker restart it became `FAILED / WORKER_LOST`, attempt count 0, observation count 0 and provider-attempt-evidence count 0. Recovery did not invent provider results or blindly retry a lost operation. This was queue fault injection, not a genuine marketing action.
- Backup/restore rehearsal used real disposable records. A stale backup comparison correctly failed after an additional test account was created (a difference the old outer `count(*)` missed). Fresh backup restored successfully into a separate disposable database with identical named table counts and immutable-payload digest `ce6c9ceb023b6f2c800e2f3f7b35e75d`. At that point the dataset contained 6 accounts/users, 3 businesses, 2 imports, 50 metric rows, 2 reports, 2 shares and 3 interventions. Live data was not overwritten by restore.

## Regression and migration results

| Gate | Result |
| --- | --- |
| Node 24 typecheck / lint / full workspace build | PASS |
| Full workspace tests | **1,386 passed, 2 pre-existing skips**; API 304, worker 117, database 259, web 123, GA4 22, plus all remaining packages. |
| W6 fixture-backed acceptance | **87/87 PASS**, separately labelled fixture evidence, not customer outcomes. |
| Built hosted, agency-record, connected-execution and GA4 runtime smokes | All PASS; provider behavior here is local stand-in / mock evidence only. |
| W7 migration rehearsal | Fresh, replay, populated upgrade, verification guards and old-0031 refusal PASS. |
| W8 migration rehearsal | Fresh, replay, populated upgrade, provenance guards and old-0031 refusal PASS. Full replay additionally preserved **49 imports, 12 reports, 22 GA4 observations and 10 execution receipts** byte-identically in the populated regression database. |
| Migration catalog | Unchanged: `291104d944ef8d5775f50b07c6e270a106d7e956411f63ca52218a063adc7075`. No migration files added or edited; incompatible historical 0031 never replayed. |
| Proxy configuration gate | Local `:80` and hostname `:443` configurations pass native Caddy adaptation. No host port or ACME certificate request involved. Added to CI. |
| PR CI | CLI and hosted checks green on the runtime-fix commit; final evidence commit must also pass before merge. |

Two parser wall-clock microbenchmarks and a filesystem-property test initially exceeded their time budgets during concurrent Docker builds. No limits were weakened. The complete unchanged suite passed once the build load settled. Initial browser harness attempts during startup and an early lazy-section click were retried after readiness; the completed journeys above passed. These retries are not represented as uninterrupted first-attempt success.

## Remaining risks and exact pilot-launch prerequisites

No unresolved blocker was demonstrated for this **local combined release**. Remaining boundaries:

1. Obtain explicit authorization for a host and public domain. This milestone provisioned neither and did not deploy publicly.
2. Select the accepted release commit, build its three images, generate a URL-safe database password (for example `openssl rand -hex 32`), and set the exact `APP_BASE_URL`. Keep PostgreSQL private and preserve the data volume.
3. For a public hostname, set `PILOT_SITE` to that hostname and map 80/443; Caddy now enables automatic HTTPS natively. Do not use the obsolete `PILOT_AUTO_HTTPS=on`. Verify real DNS, certificate issuance/renewal, proxy routing, HTTPS cookies and OAuth callback reachability on the authorized host; those are **not** established by local config adaptation.
4. Restrict a controlled pilot's operator access appropriately. Open signup, lack of application-level login rate limits, root/full-workspace application images, mutable base-image tags and lack of off-host backup scheduling remain deployment-hardening considerations, not newly solved capabilities. No load/capacity or full keyboard-only accessibility certification is claimed.
5. Configure durable off-host backups and retention; rehearse restoration with the pilot's own dataset. The committed script compares against the current source database, so run content comparisons against a quiescent snapshot, not a changing live workload.
6. Leave provider credentials absent unless explicitly authorized. GA4 remains `LIVE_GA4_BLOCKED`; a real OAuth web client, enabled Analytics APIs, registered exact HTTPS callback, encryption keys, property access and interactive consent are separate prerequisites for live GA4 verification. PR #74's live GitHub evidence was not re-run or substituted for this release's provider-independent acceptance.
7. Have an actual agency operator complete the workflow with an authorized client. A comparable evaluation requires a genuine pre-declared plan, correctly timed action, completed observation window and sufficient measurements. This acceptance intentionally did not fabricate that elapsed history.

Latest main was re-fetched before finalization: still `8089dd6`; a separate `feat/client-onboarding-redesign` branch was visible but unmerged and is not part of this accepted release. No frontend changes from that work or the port-3000 dev server were overwritten. Re-fetch and verify CI once more before merging PR #78.
