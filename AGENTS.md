# Agent notes

Practical notes for running this checkout locally. Architecture lives in
`docs/`; this file only covers day-to-day dev environment setup.

## Dev environment

- Stack: pnpm workspace (`apps/api` Effect server on :3001, `apps/web` Vite on
  :3000, `apps/worker`), Postgres 16 via Docker.
- Fastest start: `scripts/dev-up.sh`. It fetches GitHub, fast-forwards a clean
  `main` to `origin/main` (or warns when the branch is behind), installs
  dependencies, starts the database, applies migrations, restarts the API if it
  serves an older commit, starts web, and checks the demo login. It ends by
  printing the API's commit next to the checkout's and `origin/main`'s.
  It is idempotent but NOT a watcher: if OpenCode's server restarts it kills
  background tasks, so re-run the script to restore the stack.
- The script starts a setup-only worker for website discovery. It does not
  consume AI-check, publishing, or other worker queues; start the full worker
  separately when those queues are intended to run.
- Before testing or reviewing anything locally, confirm you are looking at
  current code. Work merges on GitHub through PRs, and this checkout does not
  pull by itself: on 2026-10-30 it sat at PR #85 while `origin/main` had #86
  to #94, so the app showed an old design and the newer work looked lost.
  `curl -s localhost:3001/api/health` reports the running commit as `version`;
  compare it with `git rev-parse --short=12 origin/main`.
- The API runs under `tsx` without a watcher: restart it after server changes
  or a pull. Vite hot-reloads web code but needs a restart after dependency
  changes.
- Node: the API runs on whatever `nvm` provides locally (v20 works despite the
  engines field warning); Vite and tsx are run per-app with `pnpm --filter
  @openrecord/api dev` and `pnpm --filter @openrecord/web dev`.

## Database (important)

- Docker runs through **Colima** (`~/.colima/default/docker.sock`), not Docker
  Desktop. If `docker ps` says the daemon is unreachable, run `colima start`
  (or `colima restart` when `colima list` says Running but the socket is dead)
  before anything else. The dev Postgres container has `restart:
  unless-stopped`, so it comes back on its own once the daemon is up.
- The dev database is container **`openrecord-dev-restored-20261030`** on
  `127.0.0.1:5432` (volume `openrecord-dev-restored-20261030`, `restart:
  unless-stopped`). It was restored on 2026-10-30 after the original volume
  **`openrecord_openrecord-pg`** became unbootable ("could not locate a valid
  checkpoint record"). Keep that original volume and
  `openrecord-dev-recovery-snapshot-20261030` untouched; they are the evidence
  for any further recovery.
- Do NOT run `docker compose up` from this checkout (or a worktree's compose
  file) for the dev database: the compose service mounts the damaged original
  volume. `scripts/dev-up.sh` starts the restored container instead
  (override with `OPENRECORD_DEV_PG_CONTAINER`).
- The API expects `DATABASE_URL=postgres://openrecord:openrecord@localhost:5432/openrecord_dev`.
  Note the compose default DB is `openrecord`; `openrecord_dev` holds the dev
  data. If the volume is ever recreated from scratch: `CREATE DATABASE
  openrecord_dev`, then `DATABASE_URL=... pnpm db:migrate`, then
  `DATABASE_URL=... pnpm db:seed:demo` (creates the demo login
  `demo@northstar.test` / `password123` plus five demo companies).
- Do not run `docker system prune` / `docker volume prune` on this machine
  without checking: the volumes above hold the only copies of the dev data.
