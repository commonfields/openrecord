# Authenticated measurement (W8)

OpenRecord can read daily key-event counts from one Google Analytics 4 property
through an operator-authorized, read-only connection, and use them exactly
where uploaded exports are used: the W3 series, W4 evaluations and W5 reports.
This document is the contract. The code and tests follow it.

## 1. Three things, kept apart

| Thing | Meaning | Where it lives |
| --- | --- | --- |
| **Connection** | A Google identity allowed OpenRecord to *read* Analytics for this account | `growth_ga4_connections` (+ encrypted `growth_ga4_credentials`) |
| **Binding** | One GA4 property and key event measure one W0 metric definition of one business | `growth_ga4_bindings` |
| **Observation** | What Google reported for which days, when, with which digest | `growth_metric_imports` (provenance `AUTHENTICATED_PROVIDER_API`) + `growth_ga4_observations` |

A connection is not proof of property ownership. It records the authorizing
identity (Google `sub` and verified email) and the granted scopes; the binding
records the selected property, its display name, account, time zone and the key
event's counting method, each read from Google at binding time.

GA4 is a measurement source, not the control plane. The W0 metric definition
stays the authority on what is measured: source kind `GA4_AGGREGATE_EXPORT`,
property reference, event name, reporting time zone, `EVENT_COUNT`/`COUNT`.

## 2. Authorization

Google's OAuth 2.0 authorization-code flow for a confidential web client:

- Scopes: `openid email https://www.googleapis.com/auth/analytics.readonly`.
  Nothing else is requested. A token response granting a broader Analytics
  scope (`analytics`, `analytics.edit`, `analytics.manage.users*`) or missing
  `analytics.readonly` is refused and the grant is revoked at once.
- `state`: 32 random bytes; only its SHA-256 is stored, bound to the user,
  account and business that started it; single use; ten minutes. A state from
  another session or account is indistinguishable from an unknown one.
- PKCE `S256`: the verifier is encrypted at rest with the token cipher and bound
  to the state. (Google's web-server guide does not discuss PKCE; Google's
  authorization server accepts it, and the confidential client secret is sent
  as well.)
- Redirect URI: exactly `<origin>/api/growth/ga4/oauth/callback`, `https`
  except on loopback, no query or fragment; configured, never derived from the
  request. Google requires the same exact string on the OAuth client.
- `access_type=offline`, `prompt=consent`: a refresh token on every
  authorization, including re-authorization. No `include_granted_scopes`.
- Identity: the ID token returned by the token endpoint (over TLS, directly
  from Google) is checked for issuer, audience (this client), expiry, subject
  and `email_verified`. Re-authorizing an existing connection must be the same
  Google subject.
- The callback redirects to the measurement page with a status word only
  (`connected`, `state_invalid`, `scope_refused`, ...). No code, token or error
  text from Google is ever forwarded.

Credentials: refresh and access tokens are encrypted with AES-256-GCM using a
deployment key (`GA4_TOKEN_ENCRYPTION_KEYS`, newest first for rotation). The
additional authenticated data binds a ciphertext to its connection and purpose
(`<connection>:refresh`, `<connection>:access`), so a ciphertext moved to
another row does not decrypt. The database refuses any credential value that is
not the cipher's envelope. Tokens never appear in an API response, a log line,
an error, stored evidence or a report.

Lifecycle: `ACTIVE` → `REAUTHORIZATION_REQUIRED` when Google refuses a refresh
(`invalid_grant`) or a call keeps answering 401 → `ACTIVE` again only through a
new authorization. `DISCONNECTED`: OpenRecord revokes at Google (refresh token
first), records whether Google confirmed it, and the database erases the stored
credentials in the same statement; queued jobs are cancelled. Every change is in
`growth_ga4_connection_events`. Observations are never touched.

## 3. Binding

`POST /api/growth/clients/:id/ga4/bindings` checks, in order: the business and
connection belong to the session's account; the definition is a GA4 key-event
count; its property reference names this property (`properties/N` or `N`);
its event is this event. Then, from Google: the property is in the identity's
account summaries (only properties the identity can read are ever listed or
bindable), the property's time zone equals the definition's, and the event is
one of the property's key events. The database repeats the scope, definition,
property, event, time zone and active-connection checks. Bindings are
append-only; the newest binding for a definition is the active one.

## 4. The report OpenRecord reads

One Data API `runReport` per page:

```
dateRanges: [{startDate, endDate}]
dimensions: [date, eventName]
metrics:    [keyEvents, eventCount]
dimensionFilter: eventName EXACT <event> (case-sensitive)
keepEmptyRows: true, limit 1000, returnPropertyQuota: true
```

- The stored daily value is **`keyEvents`**, found by header name. `eventCount`
  is kept in the evidence so the two are never confused (they differ when the
  key event counts once per session).
- Google documents that only recorded data can be displayed (`runReport`
  `keepEmptyRows`): a day with zero occurrences of the selected key event has
  no row, even with `keepEmptyRows`. For every requested day without a row, the
  synchronization therefore reads one unfiltered property-activity report
  (dimensions `date`, metrics `eventCount`, same window, `keepEmptyRows`).
  A day where that report proves recorded activity (eventCount ≥ 1) and the
  key-event report has no row is recorded as zero and listed in the
  observation evidence as a derived zero; the probe's own answer is stored with
  it. A day the property recorded nothing about stays absent and resolves as
  `MISSING` — missing is not zero. A zero is recorded directly when Google
  returns a row whose value is `"0"`. Derivation is never attempted from a
  suspect answer: if the filtered report is thresholded, or the activity probe
  is sampled, rolled into "(other)", thresholded, refused or malformed, the
  probe result is recorded as skipped and those days stay absent.
- Refused, nothing recorded: a response time zone different from the binding's
  (`PROPERTY_TIME_ZONE_CHANGED`), sampled data (`RESPONSE_SAMPLED`), data rolled
  into "(other)" (`RESPONSE_DATA_LOSS`), a foreign event, a day outside the
  request, a duplicate day, a non-integer or negative value
  (`RESPONSE_UNEXPECTED`). Thresholded responses are recorded and flagged
  (`subject_to_thresholding`).
- Only complete days: a request must end no later than yesterday in the
  property's time zone, and spans at most 366 days (the W3 import bound).

## 5. Provenance and evidence

Each recorded answer is one W3 import: provenance `AUTHENTICATED_PROVIDER_API`,
the definition's source kind, property reference and time zone, the requested
window as its declared coverage, and as `raw_text` a canonical JSON envelope of
the request, the normalized answer, its digest and Google's own response bodies
(no credential is in any of them). Its observation row records the connection,
the Google subject at collection time, binding, job, property, event, metric
(`keyEvents`), definition id and version, time zone, requested and observed
coverage, response digest, thresholding flag, the import it supersedes, and the
collection time.

The CSV route can never claim this provenance: its input schema accepts only
`OPERATOR_SUPPLIED_EXPORT` and `SYNTHETIC_FIXTURE`, and a deferred database
trigger refuses any authenticated import that has no observation by commit.
The observation guard requires the binding's active connection, the matching
property, event, definition version, time zone and window, and a job of that
binding that is claimed at that moment.

## 6. Reconciliation

| Case | Result |
| --- | --- |
| Initial synchronization | One import with every day Google reported (explicit rows plus derived zeros from proven property activity); days with neither stay `MISSING` |
| Repeated identical answer, same or overlapping window | `UNCHANGED`: a sync run confirms the latest import; no new import |
| Google revises a day | A new import; the day resolves to the newest collection; every earlier value stays in its import and is listed in the series' `revisions` (oldest first). Not a conflict |
| A day Google stops reporting | A new import without that day; the earlier value still resolves (W3: a later import that does not report a day cannot erase it) |
| Missing days | Never fabricated; `MISSING` inside coverage, `UNAVAILABLE` outside |
| Partial failure (outage, quota, refused answer) | Nothing is written for that attempt; everything already recorded is unchanged |
| Operator export or fixture disagrees with Google | `CONFLICT`, exactly as in W3: among authenticated imports only the newest collection takes part, every operator and fixture import does |
| Two concurrent requests or workers | One open job per binding (unique index), `SKIP LOCKED` claims, binding row lock while recording, and the job must still be claimed by the recording worker |

"Unchanged" means: for every requested day, the newest authenticated import
covering it reports the same value (or the same absence) as the new answer.

W4 still reports `CONFLICTING_DAYS`, `MISSING_DAYS`, `UNAVAILABLE_DAYS` and
`SYNTHETIC_DAYS` as before. Authenticated days count as observed (`origin
REAL`, `provider GA4_DATA_API`). A new non-blocking caveat,
`PROVIDER_REVISED_DAYS`, lists revised days. When a window reads authenticated
days, the limitation about operator-supplied exports is replaced by one that
says which values were read through the connection; evaluations of
export-only data are byte-for-byte what they were before W8.

W5 report sources carry the observation identity (connection id, binding,
property, key event, metric, time zone, requested and observed coverage,
collection time, response digest, superseded import, thresholding). No Google
account, email or credential is in a report. A published report is an
immutable stored snapshot: later synchronization changes the next preview's
evidence digest (so an old preview cannot be published) and never the stored
bytes.

## 7. Durable synchronization

`growth_ga4_sync_jobs` holds scheduling only: `BACKFILL` and `REFRESH`
(operator-requested, idempotent per request key) and `SCHEDULED`. One open job
per binding. Claims use a lease and `FOR UPDATE SKIP LOCKED`; an expired lease
(crashed worker) is reclaimed, and the stale worker's late write is refused
(`JobLeaseLost`). Every attempt appends a `growth_ga4_sync_runs` row
(`RECORDED`, `UNCHANGED`, `RETRYING`, `FAILED`).

Per attempt the worker re-proves: binding still active, its author still an
account member, connection `ACTIVE`, window complete, property readable by the
identity, property time zone unchanged, event still a key event.

| Failure | Handling |
| --- | --- |
| Access token expired | refresh (one token call), store the new ciphertext |
| 401 | one refresh and one retry; a second 401 suspends the connection |
| `invalid_grant` on refresh | suspend (`REAUTHORIZATION_REQUIRED`), job `FAILED AUTHORIZATION_REVOKED` |
| 403 / 404 on the property | `FAILED PROPERTY_ACCESS_LOST` |
| 429 / `RESOURCE_EXHAUSTED` | wait `Retry-After`, else 60 s doubling to 1 h; 8 attempts, then `FAILED QUOTA_EXHAUSTED` |
| 5xx, timeout, network | 15 s doubling to 10 min; 5 attempts, then `FAILED PROVIDER_UNAVAILABLE` |
| 400 | `FAILED PROVIDER_REJECTED` |

Scheduling: when idle, at most once a minute, the worker queues a `SCHEDULED`
refresh of the last `GA4_REFRESH_DAYS` (3) complete days for each active
binding with an active connection, no open job and no scheduled job within
`GA4_SYNC_INTERVAL_HOURS` (24); at most 50 per pass. Polling is bounded by
these limits and pagination by five pages.

Health (`GET .../ga4/bindings`): connection status, last successful sync, last
attempt and error code, open job, freshness (`NEVER_SYNCED`, `FRESH`, `STALE`
after 36 h), and over the last 28 complete days the counts of reported,
missing, not-yet-synchronized, conflicting and revised days.

## 8. Tenancy

Connections belong to an account; bindings, jobs, runs and observations to a
business of that account. Another account's connection, binding or business is
`404`. The database refuses a binding whose connection belongs to another
account, an observation from a connection other than the binding's, and an
OAuth state for a business or user outside its account.

## 9. Configuration

| Variable | Meaning |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Web OAuth client of the deployment's Google Cloud project |
| `GA4_OAUTH_REDIRECT_URI` | exactly `<APP_BASE_URL>/api/growth/ga4/oauth/callback`; https except loopback |
| `GA4_TOKEN_ENCRYPTION_KEYS` | `id:base64(32 bytes)[,id:base64...]`, newest first |
| `GA4_SYNC_INTERVAL_HOURS`, `GA4_REFRESH_DAYS` | scheduling (defaults 24, 3) |
| `GA4_PROVIDER_STAND_IN_URL` | tests and smoke only: an exact loopback origin; anything else disables GA4 |

Missing or invalid values disable the feature; the routes answer
`Ga4NotConfigured` and the UI says so. Access requirements on Google's side:
enable the Google Analytics Admin API and Data API on the project, configure the
OAuth consent screen with the `analytics.readonly` scope, register the redirect
URI, and complete Google's OAuth app verification before serving more than 100
users (unverified apps show a warning).

## 10. Database (migration `0035`)

Additive and replay-safe. It widens `growth_metric_imports.provenance` with
`AUTHENTICATED_PROVIDER_API` (the 0032 replay keeps the table, so the widened
check survives), adds the eight `growth_ga4_*` tables, their guards, the
deferred observation requirement, append-only triggers on events, bindings,
runs and observations, and two read views that never select credentials. It
refuses to run before 0034 and over the preserved W2 0031 artifacts.
`scripts/verify-marketing-w8-migrations.py` proves fresh install, replay,
populated upgrade, catalog parity, the refusals, and that a replay leaves every
import, row, report, execution receipt and observation byte-identical.

## 11. Evidence

| Claim | Test |
| --- | --- |
| OAuth request, PKCE, identity, scopes, cipher, report reading, zero derivation, errors without secrets | `packages/ga4/test/ga4.test.ts` |
| provenance cannot be forged, binding/observation guards, ciphertext-only, append-only | `packages/db/src/growth-ga4.integration.test.ts` |
| OAuth flow, CSRF/state, cross-account, unauthorized property, revoked token, disconnect, redaction | `apps/api/src/growth-ga4.integration.test.ts` |
| aggregation, time zone, idempotency, revisions, missing days, derived zeros, outages, quota, refresh, suspension, concurrency, crash recovery, scheduling, W4 and W5 | `apps/worker/src/ga4-sync.integration.test.ts` |
| plain-language states and report wording | `apps/web/tests/growth-ga4.test.ts` |
| fresh, replay, populated, incompatible databases | `scripts/verify-marketing-w8-migrations.py` |
| built API and worker over real HTTP, independent Google stand-in, no secret in responses, logs or evidence | `scripts/ga4-measurement-runtime-smoke.py` (CI) |

All provider behavior in these tests is modeled (`MOCK_ADAPTER_PASS`). None of
it is `LIVE_PROVIDER_PASS`: no live Google OAuth client or GA4 property was
available while W8 was built.

## 12. Not in W8

Other measurement sources (booking systems, CRMs), currency metrics, ad or
social reporting, any write to Google Analytics, webhooks, per-source/medium
detail, new metric definitions from the UI, and any execution adapter. The next
execution adapter is decided in `marketing-channel-boundaries-v1.md`.
