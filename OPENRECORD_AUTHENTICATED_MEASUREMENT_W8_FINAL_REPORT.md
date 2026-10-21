# OpenRecord authenticated measurement (W8) — final report

All provider behavior verified in this milestone is **modeled**: an in-process
Google fixture and an independent local Google stand-in over HTTP. No live
Google OAuth client, no live GA4 property and no customer data were used.
**Live verification is blocked** until a deployment has a Google OAuth client
(with the Analytics Admin and Data APIs enabled and the redirect URI
registered) and a GA4 property to read. Nothing here is customer evidence.

## 1. Repository

| Item | Value |
| --- | --- |
| Starting `origin/main` | `2406a6cbd9829a6770f64054a4e6f3e3f7d67aab` (verified by fetch) |
| Worktree / branch | `/Users/wira/openrecord-w8`, `feat/authenticated-measurement-w8-v1` |
| Migration | `0035_growth_ga4_measurement_v1.sql` (additive; `0031` never replayed; refuses to run before `0034` or over `0031` artifacts) |
| Final SHA, PR, merge | Recorded in the hand-off message: a report inside the PR cannot contain its own merge SHA. |

Files (new unless noted):

- ga4 (new package `@openrecord/ga4`): OAuth client (state, PKCE S256, ID-token identity, refresh, revoke), Admin/Data API reads, the key-event report and its strict parser, AES-256-GCM token cipher, deployment configuration, faithful fixture (+ `test/ga4.test.ts`)
- contracts: `growth-ga4.ts`; `growth-measurement.ts` (stored provenance, `provider` on series days, `revisions`), `growth-evaluation.ts` (`PROVIDER_REVISED_DAYS` caveat), `growth-report.ts` (observation on report sources), `index.ts`
- db: migration `0035`; `growth-ga4.ts` (+integration test); `growth-measurement.ts` (revision-aware conflict resolution), `growth-evaluation-rules.ts` (provider limitation and assumption), `growth-report.ts` (observation refs), `growth-repositories.ts`, `index.ts`
- api: `growth-ga4-routes.ts` (+integration test), `router.ts`, `server.ts`, `package.json`
- worker: `ga4-sync-runner.ts` (+integration test), `runner.ts`, `package.json`
- web: `components/growth-ga4.tsx`, `lib/growth-ga4.ts`, `components/growth-measurement.tsx`, `routes/client-growth-measurement.tsx`, `components/growth-report-view.tsx`, `lib/growth-report.ts`, `lib/growth.ts`, `tests/growth-ga4.test.ts`
- scripts: `verify-marketing-w8-migrations.py`, `ga4-measurement-runtime-smoke.py`; CI runs the smoke
- docs: `docs/engineering/authenticated-measurement-w8.md`, `docs/engineering/marketing-channel-boundaries-v1.md`, runbook section 14, `docs/growth-measurement-p3.md` (W8 note), `.env.example`

## 2. Architecture

- **Connection ≠ binding ≠ observation.** A connection records which Google
  identity allowed read access (subject, verified email, scopes); a binding
  ties one property and key event to one immutable metric definition; an
  observation records what Google reported, when, with which digest.
- **Reuse, not a parallel store.** Each synchronized answer is a W3 import with
  a new provenance, `AUTHENTICATED_PROVIDER_API`, plus one observation row. W3
  series, W4 evaluation and W5 reports read it unchanged. The CSV path is
  unchanged and cannot claim the new provenance (schema and a deferred
  database trigger).
- **Reconciliation.** Newer authenticated collections revise older ones
  (`revisions`, never `conflicts`); disagreement with an operator or fixture
  import is still `CONFLICT`. Identical answers are confirmed as `UNCHANGED`
  without new evidence. Missing days are never fabricated; zero only when
  Google reports zero.
- **Durable sync** on PostgreSQL jobs (one open per binding, leases,
  `SKIP LOCKED`), bounded retries and quota waits, connection suspension on
  refused authorization, bounded daily scheduling, health and freshness.
- **No generic connector SDK.** Shared pieces (encrypted credentials, durable
  jobs, append-only evidence) stay concrete until a second execution adapter
  exists.

## 3. Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | pass (all 15 workspace projects) |
| `pnpm lint` | pass (0 warnings) |
| `pnpm test` (PG16, CI environment variables) | pass: packages/db 31 files, apps/api 34, apps/worker 13, apps/web 15 (111 tests), packages/ga4 18 tests, all other packages unchanged and passing |
| W8 tests | ga4 18, db guards 4, API 8, worker 14, web 5 |
| `pnpm build` | pass |
| `verify-marketing-w8-migrations.py` | pass: fresh + replay, populated upgrade + replay, catalog parity, provenance contract intact after full replay, forged provider import refused, plaintext credential refused, `0031` column and tables refused by `0035` with no W8 objects, refused before `0034`; replay over a populated database left 86 imports, 14 published reports, 57 GA4 observations and 15 execution receipts byte-identical |
| `verify-marketing-w7-migrations.py` | still pass after `0035` |
| `ga4-measurement-runtime-smoke.py` | pass (18 checks, twice): built API and worker, independent Google stand-in, OAuth with PKCE over HTTP, replay refused, property authorization, sync, idempotency, revision, tenancy, disconnect with revocation, no token, code, secret or key in any response, process log or stored evidence |

Acceptance mapping:

| Requirement | Evidence |
| --- | --- |
| Valid OAuth connection | API "connects through Google…", smoke G.02–G.06 |
| CSRF/state mismatch refusal | API "refuses a forged, foreign or expired state…" (forged, malformed, other account's, expired, reused, denied consent) |
| Unauthorized property refusal | API "lists only properties…" (`PropertyNotAccessible`), smoke G.08 |
| Cross-account access refusal | API "keeps connections and bindings inside their account", db "binds only…", smoke G.15 |
| Expired/revoked token | worker "refreshes an expired access token…", "suspends the connection…"; API "suspends on revoked authorization…" |
| Credential redaction | API response sweep, smoke G.18, ga4 error tests, db ciphertext-only check |
| Key-event daily aggregation, timezone, metric binding | worker "records exact daily key-event counts…", ga4 report tests, API binding refusals |
| Repeated sync idempotent | worker "is idempotent…", smoke G.12 |
| Historical revisions preserved | worker "preserves historical provider revisions…", smoke G.13 |
| Missing days not fabricated | worker and smoke G.11 |
| Provider errors recoverable | worker outage and quota tests |
| Concurrent jobs do not duplicate evidence | worker "concurrent workers and a crashed worker…", db one-open-job index |
| GA4 observations in W4 evaluations | worker W4/W5 test (`COMPARABLE`, provider limitation) |
| W5 reports byte-identical after later sync | worker W4/W5 test (stored `snapshot_text` and digest unchanged; next preview digest differs) |
| Manual CSV path still available | all W3 tests pass unchanged; UI keeps the import form |

## 4. Security review

- Minimum scopes (`openid email analytics.readonly`); broader or missing
  Analytics scopes are refused and the grant revoked. No write path to
  Analytics exists in the code.
- State: hashed, user/account-bound, single use, ten minutes. PKCE S256.
  Redirect URI exact and configured, never request-derived. Callback redirects
  carry only a status word.
- Tokens: AES-256-GCM with deployment keys (rotation supported), AAD-bound to
  connection and purpose; the database refuses non-ciphertext values and erases
  credentials on disconnect; revocation at Google on disconnect.
- Tenancy enforced in routes (404), repository and database guards.
- Logs carry ids and stable codes only; provider errors keep only Google's
  status enum.
- The ID token is not signature-verified: it is received directly from Google's
  token endpoint over TLS, which Google documents as sufficient; issuer,
  audience, expiry, subject and verified email are checked.

## 5. Product acceptance

The measurement page gains one panel: connect (read-only), link property and
key event, synchronize dates, refresh now, connection status, last successful
synchronization, freshness, coverage (reported, missing, not yet synchronized,
conflicting, revised), the last error in plain language, reconnect and
disconnect. The upload form is unchanged. The UI was verified by typecheck and
server-render tests, not in a live browser session.

## 6. Cross-channel decision

`docs/engineering/marketing-channel-boundaries-v1.md` compares website/CMS,
Facebook Pages, Instagram, X, Google Business Profile, Meta and Google Ads, email
and measurement sources on authorization, execution, verifiable evidence,
measurement and access limits. Decision: **WordPress page and post updates**
follow W8 (Application Passwords without platform review, revision read-back as
byte-comparable evidence, measured through GA4/booking sources). Second:
Google Business Profile once API access is approved. Not implemented.

## 7. Limits and non-goals

- Live Google verification blocked (no OAuth client or property available).
- Google's OAuth app verification for `analytics.readonly` is required before
  serving more than 100 users; until then users see an unverified-app warning.
- Days without a GA4 row are `MISSING`. Whether Google returns explicit zero
  rows for a filtered event with `keepEmptyRows` must be confirmed live; if it
  does not, low-volume properties will show missing rather than zero days, which
  W4 treats as incomplete (the safe direction).
- One property and key event per metric definition; no new metric definitions
  from the UI; no source/medium detail; no other measurement sources.

## 8. Evidence status

`MOCK_ADAPTER_PASS` for all provider behavior. Not `LIVE_PROVIDER_PASS`.
