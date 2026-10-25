# Hosted pilot deployment (v1)

How to run OpenRecord for a small controlled agency pilot: a browser, one
origin, no local Node/pnpm/PostgreSQL for the operator. This is a pilot
deployment path, not a cloud platform: three application processes plus
PostgreSQL behind one reverse proxy, reproducible from the repository.

## Architecture

```
browser ──> caddy (web) ──static SPA──> built apps/web (immutable assets)
                 │
                 └──/api/*──> api (migrate + serve) ──> PostgreSQL 16 (private network, no published ports)
                                   worker (migrate + job loops)
```

- **One origin** serves both the SPA and the API: session cookies
  (`HttpOnly`, `SameSite=Lax`, `Secure` on https origins) and the configured
  `APP_BASE_URL` (exact-origin write protection) match the browser origin.
- **web** (`caddy:2-alpine`): serves the hashed Vite assets (immutable cache),
  the entry document (`no-cache`), falls back to `index.html` for SPA routes,
  and reverse-proxies `/api/*` to the api service. In public mode it obtains
  and renews the TLS certificate automatically (ACME).
- **api**: runs the idempotent, advisory-locked migrations, then serves the
  built API (`apps/api/dist/server.js`, workspace TypeScript compiled at
  runtime by tsx — the same runtime shape as `pnpm start`).
- **worker**: the same durable job loops as in development (checks, discovery,
  site inspection, assay, connected execution, GA4 sync). Jobs live in
  PostgreSQL with leases; an interrupted worker's jobs are reclaimed, so
  restarts are safe by design.
- **db**: PostgreSQL 16 with a persistent named volume (`pgdata`). It
  publishes **no ports**; administrative access runs inside the compose
  network (`scripts/hosted-pilot-backup.sh`).

Version identification: the deployment writes its git commit to
`OPENRECORD_BUILD_COMMIT` (`scripts/hosted-pilot-release.sh`); `/api/health`
exposes the short commit and process/database readiness. `/api/dev/runtime`
has fuller operator-only diagnostics in development; it returns 404 in
production.

## Files

| Path | Purpose |
| --- | --- |
| `Dockerfile` | one file, three targets (`api`, `worker`, `web`); Node 24 per the runtime baseline |
| `deploy/hosted-pilot.compose.yaml` | the whole stack; private network; `pgdata` volume; healthchecks |
| `deploy/Caddyfile` | static SPA + `/api` proxy + automatic HTTPS (public mode) |
| `deploy/.env.example` | every required and optional variable, without secrets |
| `scripts/hosted-pilot-release.sh` | stamps the deployed commit into `deploy/.env` |
| `scripts/hosted-pilot-backup.sh` | `pg_dump` backup + disposable-database restore rehearsal |
| `scripts/hosted-pilot-deployment-smoke.py` | builds, boots and verifies the pilot path end to end |

## Run the local pilot

```bash
git clone https://github.com/commonfields/openrecord && cd openrecord
cp deploy/.env.example deploy/.env          # then fill in the values
scripts/hosted-pilot-release.sh             # stamp the deployed commit
docker compose -f deploy/hosted-pilot.compose.yaml --env-file deploy/.env up -d --build
open http://localhost:8080
```

Sign up an operator account in the browser, add a client, and run the growth
workflow (initiative → approval → plan → attested action → aggregate import →
evaluation → decision → report → share). Stop with
`docker compose -f deploy/hosted-pilot.compose.yaml --env-file deploy/.env down`
(data survives in the `pgdata` volume; add `-v` only when you mean to erase it).

## Public pilot (requires an authorized domain)

1. Point a DNS A/AAAA record for the pilot domain at the host.
2. In `deploy/.env`: set `APP_BASE_URL=https://<domain>`, `PILOT_SITE=<domain>`,
   `PILOT_HTTP_PORT=80`, `PILOT_HTTPS_PORT=443`, and map
   both ports in compose so Caddy can answer the ACME challenge.
3. `up -d --build` as above; Caddy obtains and renews the certificate.
4. GA4 OAuth compatibility: with a public https origin, set
   `GA4_OAUTH_REDIRECT_URI=https://<domain>/api/growth/ga4/oauth/callback` and
   register exactly that URI on the Google OAuth client. Until those
   credentials exist the GA4 feature stays safely disabled (`Ga4NotConfigured`).

## Operations

- **Health**: `GET /api/health` → `200 {"ok":true,"db":true,"version":"<short commit>"}` or `503` when the
  database does not answer; used by the compose healthcheck and safe for load
  balancers. `version` is null when the deployment did not state its commit.
- **Logs**: `docker compose -f deploy/hosted-pilot.compose.yaml logs`. The
  applications log ids and codes, never credentials or customer payloads; the
  deployment smoke asserts this against the configured secrets.
- **Backup**: `scripts/hosted-pilot-backup.sh backup` writes a compressed
  `pg_dump` under `backups/`. **Restore rehearsal**:
  `scripts/hosted-pilot-backup.sh verify <file>` restores into a disposable
  database and compares row counts — the live database is never touched.
  Schedule the backup command (cron/timer) for a real pilot; keep the dumps
  somewhere other than the database host.
- **Restart**: `docker compose ... restart` (or host reboot with
  `restart: unless-stopped`). Sessions, business data and published reports
  persist; queued jobs are reclaimed after the lease expires.
- **Migrations**: run automatically before each process starts. They are
  replay-safe and serialized by an advisory lock; the historical `0031`
  delivery migration is excluded from the lineage and refused by 0030+.

## Security posture and limits

- The API refuses fixture ("mock") check-runs unless the deployment explicitly
  sets `RECORD_ALLOW_FIXTURE=1`, and an omitted provider now means the real
  hosted provider — mock evidence cannot enter production data by default.
- Without provider credentials, provider-backed work fails honestly
  (`PROVIDER_UNAVAILABLE`/`PROVIDER_UNSUPPORTED`); nothing fabricates answers.
  GA4 remains fully disabled until all four `GOOGLE_OAUTH_*`/`GA4_*` values
  are configured.
- PostgreSQL is reachable only from the compose network. Do not publish it.
- Not yet provided (documented honestly, not silently missing): in-app rate
  limiting (the proxy provides connection-level limits only), TLS client
  authentication, external object storage for raw evidence (evidence is stored
  in PostgreSQL today), and automated off-host backup shipping.
