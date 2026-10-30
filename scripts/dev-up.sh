#!/usr/bin/env bash
# Bring up the local dev stack: Postgres (Docker/Colima), API (:3001), web (:3000).
# Safe to re-run: it only starts what is missing, and restarts the API when it
# is serving an older commit than this checkout.
# Login afterwards: http://localhost:3000/signin — demo@northstar.test / password123
set -euo pipefail
cd "$(dirname "$0")/.."

DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord_dev"
# The dev database container. Since 2026-10-30 this is the restored copy; the
# original volume openrecord_openrecord-pg is damaged and must not be started.
DEV_PG_CONTAINER="${OPENRECORD_DEV_PG_CONTAINER:-openrecord-dev-restored-20261030}"

# 0. Code freshness: work lands on GitHub through PRs, so this checkout's main
#    can lag origin/main and serve an old design. Fast-forward when safe,
#    otherwise say so loudly.
if git fetch -q origin main 2>/dev/null; then
  branch="$(git rev-parse --abbrev-ref HEAD)"
  behind="$(git rev-list --count HEAD..origin/main)"
  if [ "$behind" -gt 0 ]; then
    if [ "$branch" = "main" ] && [ -z "$(git status --porcelain)" ]; then
      echo "main is $behind commits behind origin/main; fast-forwarding"
      git merge -q --ff-only origin/main
    else
      echo "WARNING: $branch is $behind commits behind origin/main; the app will not show the latest merged work" >&2
    fi
  fi
else
  echo "WARNING: could not fetch origin; cannot tell whether this checkout is current" >&2
fi
pnpm install --prefer-offline >/dev/null

# 1. Database: Colima must run for Docker at all.
if ! docker info >/dev/null 2>&1; then
  colima list | grep -q default.*Running && colima restart || colima start
fi
# Skip when Postgres already answers on 5432 (another container or a tunnel may
# hold the port; starting a second one would fail).
if ! pg_isready -h localhost -p 5432 -U openrecord >/dev/null 2>&1; then
  if docker container inspect "$DEV_PG_CONTAINER" >/dev/null 2>&1; then
    docker start "$DEV_PG_CONTAINER" >/dev/null
  else
    echo "ERROR: dev database container $DEV_PG_CONTAINER not found; see AGENTS.md (Database) before starting anything" >&2
    exit 1
  fi
fi
until pg_isready -h localhost -p 5432 -U openrecord >/dev/null 2>&1; do sleep 1; done
# Migrations replay idempotently, so this is safe on every run.
DATABASE_URL="$DATABASE_URL" pnpm db:migrate >/dev/null

# Website setup has its own local worker so it can make progress without
# consuming queued provider calls or dispatching unrelated work.
setup_pid_file="/tmp/openrecord-setup-worker.pid"
setup_pid="$(cat "$setup_pid_file" 2>/dev/null || true)"
if [ -z "$setup_pid" ] || ! ps -p "$setup_pid" -o command= 2>/dev/null | grep -q '[s]rc/setup-only.ts'; then
  echo "starting setup worker (logs: /tmp/opencode-setup-worker.log)"
  DATABASE_URL="$DATABASE_URL" nohup pnpm --filter @openrecord/worker exec tsx src/setup-only.ts > /tmp/opencode-setup-worker.log 2>&1 &
  echo "$!" > "$setup_pid_file"
fi

# 2. API on :3001 (no watcher). Restart it when it serves an older commit.
head_sha="$(git rev-parse --short=12 HEAD)"
if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  running="$(curl -s http://localhost:3001/api/health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  if [ "$running" != "$head_sha" ]; then
    echo "API serves ${running:-unknown}, checkout is $head_sha; restarting API"
    kill $(lsof -tiTCP:3001 -sTCP:LISTEN)
    while lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
  fi
fi
#    OPENRECORD_LOCAL_BRIDGE=1: the API starts a bridge for the signed-in user
#    on this computer, so local CLI subscriptions work without pairing.
if ! lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting API on :3001 (logs: /tmp/opencode-api.log)"
  DATABASE_URL="$DATABASE_URL" \
  PORT=3001 APP_BASE_URL="http://localhost:3000" OPENRECORD_LOCAL_BRIDGE=1 \
    nohup pnpm --filter @openrecord/api dev > /tmp/opencode-api.log 2>&1 &
fi

# 3. Web on :3000 (Vite hot-reloads code changes; restart it by hand after a
#    dependency change).
if ! lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting web on :3000 (logs: /tmp/opencode-web.log)"
  nohup pnpm --filter @openrecord/web dev > /tmp/opencode-web.log 2>&1 &
fi

for _ in $(seq 1 60); do
  curl -s -o /dev/null http://localhost:3001/api/health && curl -s -o /dev/null http://localhost:3000/ && break
  sleep 1
done
curl -s -o /dev/null -w "api:    %{http_code}\n" -X POST http://localhost:3001/api/auth/signin \
  -H "Content-Type: application/json" -d '{"email":"demo@northstar.test","password":"password123"}'
curl -s -o /dev/null -w "web:    %{http_code}\n" http://localhost:3000/
running="$(curl -s http://localhost:3001/api/health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
echo "commit: API $running, checkout $head_sha ($(git rev-parse --abbrev-ref HEAD)), origin/main $(git rev-parse --short=12 origin/main)"
echo "ready → http://localhost:3000 (demo@northstar.test / password123)"
