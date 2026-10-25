# Agent notes

Practical notes for running this checkout locally. Architecture lives in
`docs/`; this file only covers day-to-day dev environment setup.

## Dev environment

- Stack: pnpm workspace (`apps/api` Effect server on :3001, `apps/web` Vite on
  :3000, `apps/worker`), Postgres 16 via Docker.
- Fastest start: `scripts/dev-up.sh` — brings up the database, API and web,
  skipping anything already running, and verifies the demo login at the end.
  Note it is idempotent but NOT a watcher: if OpenCode's server restarts it
  kills background tasks, so re-run the script to restore the stack.
- Node: the API runs on whatever `nvm` provides locally (v20 works despite the
  engines field warning); Vite and tsx are run per-app with `pnpm --filter
  @openrecord/api dev` and `pnpm --filter @openrecord/web dev`.

## Database (important)

- Docker runs through **Colima** (`~/.colima/default/docker.sock`), not Docker
  Desktop. If `docker ps` says the daemon is unreachable, run `colima start`
  (or `colima restart` when `colima list` says Running but the socket is dead)
  before anything else. The dev Postgres container has `restart:
  unless-stopped`, so it comes back on its own once the daemon is up.
- The dev database is Docker volume **`openrecord_openrecord-pg`** (external,
  long-lived). It holds real accumulated dev data — never prune it.
- Start it with `docker compose up -d` from this checkout root. The compose
  file mounts that external volume and sets `restart: unless-stopped`, so it
  survives Docker Desktop restarts and comes back on its own.
- The API expects `DATABASE_URL=postgres://openrecord:openrecord@localhost:5432/openrecord_dev`.
  Note the compose default DB is `openrecord`; `openrecord_dev` holds the dev
  data. If the volume is ever recreated from scratch: `CREATE DATABASE
  openrecord_dev`, then `DATABASE_URL=... pnpm db:migrate`, then
  `DATABASE_URL=... pnpm db:seed:demo` (creates the demo login
  `demo@northstar.test` / `password123` plus five demo companies).
- Do not run `docker system prune` / `docker volume prune` on this machine
  without checking: the volume above is the only copy of the dev data.
