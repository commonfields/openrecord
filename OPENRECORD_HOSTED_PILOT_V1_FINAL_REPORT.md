# OPENRECORD_HOSTED_PILOT_V1_FINAL_REPORT

Milestone: hosted pilot deployment readiness — web + API + worker + PostgreSQL 16 behind one origin, reproducible from the repository, verified against the actual containerized stack.

Date: 2026-10-24. Verdict: **`HOSTED_PILOT_LOCAL_VERIFIED`** (a successful local deployment; not a production deployment, not customer validation, not GA4 live verification).

## 1. Starting and ending SHA and PR

| | SHA |
| --- | --- |
| Starting `main` | `a498f515f4b0f6ae63b4b8a3c34b1ecaf1075a1d` (PR #74, matches the milestone's last-verified main; no upstream drift at start) |
| Branch | `feat/hosted-pilot-v1` @ `0b6986b` → **PR #75** |
| Parallel work | Product Experience V1 had **no branches pushed and no merged changes** on `main` at fetch time; no overlap existed. `apps/web` frontend files are untouched by this branch. |

## 2. Architecture and hosting requirements

```
browser ──> caddy (web) ──built SPA──> apps/web dist (hashed immutable assets, no Vite)
                 └──/api/*──> api (migrate + serve) ──┐
                             worker (migrate + loops) ─┴──> PostgreSQL 16 (private network, no published ports, pgdata volume)
```

- **One origin** for SPA + API: `HttpOnly` `SameSite=Lax` session cookies (with `Secure` on https origins) and the API's exact-origin write protection both match the browser origin (`APP_BASE_URL`).
- **web** = `caddy:2-alpine` + built dist: `try_files … /index.html` SPA fallback, immutable cache for hashed assets, `no-cache` entry document, automatic ACME TLS in public mode.
- **api/worker** = the existing built processes (`apps/api/dist/server.js`, `apps/worker/dist/runner.js`) with tsx compiling workspace TypeScript at runtime — the same runtime shape as `pnpm start`. Migrations run before serving (idempotent, advisory-locked, so both processes race safely).
- **Graceful shutdown**: `NodeRuntime.runMain` installs SIGTERM/SIGINT handlers; `Layer.launch` tears the HTTP server, pools and worker fibers down; durable jobs use leases and are reclaimed after expiry.

Hosting requirements for the real pilot: any Docker 24+ host with 2 vCPU / 4 GB, ports 80/443 reachable for a public domain (or a mapped port for the local pilot), and persistent disk for the `pgdata` volume and off-host backups. No Kubernetes, no managed cloud services required.

## 3. Required configuration (no secrets)

Copy `deploy/.env.example` → `deploy/.env`: `POSTGRES_USER/PASSWORD/DB`, `APP_BASE_URL` (exact browser origin), proxy mode (`PILOT_SITE`, `PILOT_AUTO_HTTPS`, port mappings), `OPENRECORD_BUILD_COMMIT` (stamped by `scripts/hosted-pilot-release.sh`). Optional provider credentials live in an optional, git-ignored `deploy/provider.env` (see `deploy/provider.env.example`): Gemini, GitHub execution (W7), GA4 OAuth (W8), 9Router. **An absent file means every provider integration stays safely disabled** — a lesson encoded after the worker rejected empty-string keys ("provider key must be nonempty"): secrets are injected only when they exist.

Deliverables: `Dockerfile`, `deploy/hosted-pilot.compose.yaml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/provider.env.example`, `scripts/hosted-pilot-release.sh`, `scripts/hosted-pilot-backup.sh`, `scripts/hosted-pilot-deployment-smoke.py`, `docs/operations/hosted-pilot-v1.md`.

## 4. Test and CI results

| Gate | Result |
| --- | --- |
| Typecheck / lint / build (Node 24) | pass |
| Full workspace tests | pass — api 304 (incl. 3 new deployment tests), worker 117, db 259, web 111, ga4 22, site-operator 45, providers 45, discovery 99, representation 202, truth 40, protocol 31, contracts 19, domain 11, config 8 |
| Migration rehearsals (W7, W8 re-run this milestone) | pass (fresh + replay + populated upgrade; catalog SHA `291104d9…`; old `0031` refused) |
| Runtime smokes: hosted, agency, connected-execution (W7), GA4 (W8) | pass — run again on the final tree |
| W6 acceptance driver | **87/87** |
| Docker image build | all three targets build from the repository (verified twice; also from compose) |
| Deployment smoke | **27/27 checks** (`scripts/hosted-pilot-deployment-smoke.py`) |
| CI on PR #75 | verified before merge (see PR) |

Notable fixed findings during verification:
- **Check-runs defaulted to `provider: "mock"`** and accepted mock from any operator — mock evidence could enter production data. Now: an omitted provider means `9router` and mock is refused (`409 CheckRunRefused / FixtureProviderDisabled`) unless `RECORD_ALLOW_FIXTURE=1`. The hosted runtime smoke (which is mock-by-design) sets the flag explicitly; the deployment smoke runs with **no** fixture flags.
- **Empty-string provider keys** stopped the worker: compose now injects provider credentials only through the optional `deploy/provider.env`.
- The smoke's `until()` originally crashed on connection resets during startup — now tolerates them (normal during container start).

## 5. Deployment smoke — 27/27 against the real containerized stack

P.01–P.04: images build; stack starts from a clean environment; `/api/health` ready (`{"ok":true,"db":true,"version":"a498f515f4b"}`); version identification matches the stamped commit.
P.05–P.16 (the pilot workflow through the browser origin): operator account created; session cookie authenticates; cookie behavior matches origin scheme; client onboarded with goal + daily-aggregate metric; initiative approved; measurement plan declared; operator-attested action recorded (attestation, never provider verification); clearly-labelled test daily aggregates imported in the actual export format (`OPERATOR_SUPPLIED_EXPORT`, "TEST dataset" header); evaluation; human decision; report preview published as an immutable snapshot; **public share URL read from an unauthenticated session**.
P.13a/P.13b (evaluation honesty): a plan declared after a backdated action cannot be read as pre-declared (`INDETERMINATE` + `PLAN_DECLARED_AFTER_EXECUTION`), and an unfinished observation window stays indeterminate (`OBSERVATION_INCOMPLETE`) — the deployed stack never manufactures a comparable result.
P.17–P.19 (security): mock check-runs refused without the fixture flag; a real-provider check run queues and fails honestly without credentials (no mock evidence); another account's data is 404.
P.20–P.23 (recovery): full restart (api + worker + db); operator session, business data and published reports survive; **a check run enqueued before the restart is claimed and processed after it** (honest failure without credentials — proving lease/queue recovery, with job-level recovery also covered by `run-lease`/`execution` integration tests).
P.24–P.27 (isolation + ops): PostgreSQL publishes no host port; backup written (`pg_dump` custom format); **restore rehearsal verified in a disposable database with identical row counts AND identical content digests** over report snapshots, raw evidence, import raw text and observations; application logs contain no database password, token or key.

Production build proof: `Server: Caddy`, hashed `/assets/*.js` served immutable, zero Vite references, and the web container contains no node/Vite binaries — production cannot depend on development servers.

## 6. Backup/restore results

`scripts/hosted-pilot-backup.sh backup` → compressed custom-format dump; `verify <file>` → restores into `pilot_restore_check` (live database never touched), compares row counts across ten evidence-bearing tables and md5 content digests of the immutable payloads. Rehearsal result: **identical counts and identical content digest `d345fe38f8867ef9…`**.

## 7. Security checks

- Session cookies: `HttpOnly`, `SameSite=Lax`, `Secure` exactly when the origin is https; 30-day server-side sessions; sign-out clears.
- Origin checks: non-GET writes from any origin other than `APP_BASE_URL` are `403 OriginRefused` (the smoke hit this exactly as designed when its Origin disagreed with `APP_BASE_URL`).
- Account isolation: cross-account reads/writes 404 on the deployed stack (P.19), matching the in-process tests.
- Database isolation: no published ports (P.24); administrative access only inside the compose network.
- Secret handling: secrets only in git-ignored `deploy/.env` / optional `deploy/provider.env`; logs scanned against every configured secret value (P.27); the GA4/OAuth callback stays compatible with a future public https domain (`GA4_OAUTH_REDIRECT_URI` must equal `<origin>/api/growth/ga4/oauth/callback`, registered on the Google client).
- Mock/fixture hygiene: no fixture flags in the deployed stack; mock check-runs refused (P.17); historical `0031` remains excluded and refused by the lineage.

## 8. Verified versus unverified runtime capabilities

**Verified (deployed stack):** clean-environment start; built web/API/worker communication over one origin; readiness + version identification; migrations on boot (fresh + replay); the complete growth pilot workflow; report publication, anonymous share, revocation; restart persistence of data/sessions/reports; worker queue recovery; database network isolation; backup + content-verified restore; secret-free logs; image builds from a clean checkout.

**Verified only in mock/test contexts:** provider-backed integrations (W7 GitHub execution, W8 GA4, Gemini/9Router checks) — PR #74 covers live GitHub; GA4 remains `LIVE_GA4_BLOCKED`.

**Not yet provided (documented in `docs/operations/hosted-pilot-v1.md`, not silently missing):** in-app rate limiting (proxy-level connection limits only), off-host automated backup shipping, external object storage (raw evidence lives in PostgreSQL), TLS client authentication, multi-host scaling.

## 9. Exact remaining steps to launch a real hosted agency pilot

1. Obtain an authorized host (any Docker-capable VM) and a DNS record for the pilot domain. *(Blocked without authorization: no hosting account or domain was available for this milestone — external deployment not attempted.)*
2. On the host: clone the repo at the deployed commit, `cp deploy/.env.example deploy/.env`, fill in `APP_BASE_URL=https://<domain>`, `PILOT_SITE=<domain>`, `PILOT_AUTO_HTTPS=on`, port mappings 80/443, a generated `POSTGRES_PASSWORD`; `scripts/hosted-pilot-release.sh`.
3. `docker compose -f deploy/hosted-pilot.compose.yaml --env-file deploy/.env up -d --build`; confirm `GET /api/health` reports the expected commit.
4. Create the operator account in the browser; store the password in the agency's password manager.
5. Optional integrations: create `deploy/provider.env` from its example (9Router for checks; GitHub execution only for the agency's own disposable repos; GA4 only when the OAuth client + test property are authorized and Google app verification is planned).
6. Run `scripts/hosted-pilot-backup.sh backup` and schedule it (cron) with off-host copy; rehearse `verify` once with real data.
7. Run the pilot workflow with the real agency client; publish and share the first real report.

## 10. Scope discipline

`apps/web` frontend files untouched (the Product Experience agent's boundary respected; the only web-adjacent change is the built dist being *served* by Caddy). No schema changes, no migration files added or modified, no new marketing features or provider adapters, no new UI/UX. The only API changes are the readiness endpoint and the production fixture gate, both deployment-required and covered by new integration tests.
