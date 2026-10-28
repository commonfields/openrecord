#!/usr/bin/env bash
# Bring up the local dev stack: Postgres (Docker/Colima), API (:3001), web (:3000).
# Safe to re-run: it only starts what is missing.
# Login afterwards: http://localhost:3000/signin — demo@northstar.test / password123
set -euo pipefail
cd "$(dirname "$0")/.."

# 1. Database: Colima must run for Docker at all; the compose service then
#    mounts the long-lived external volume openrecord_openrecord-pg.
if ! docker info >/dev/null 2>&1; then
  colima list | grep -q default.*Running && colima restart || colima start
fi
# Skip compose when Postgres already answers on 5432 (another container or a
# tunnel may hold the port; starting a second one would fail).
if ! pg_isready -h localhost -p 5432 -U openrecord >/dev/null 2>&1; then
  docker compose up -d
fi
until pg_isready -h localhost -p 5432 -U openrecord >/dev/null 2>&1; do sleep 1; done

# 2. API on :3001 (no watcher: restart it manually after server code changes).
#    OPENRECORD_LOCAL_BRIDGE=1: the API starts a bridge for the signed-in user
#    on this computer, so local CLI subscriptions work without pairing.
if ! lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting API on :3001 (logs: /tmp/opencode-api.log)"
  mkdir -p /tmp
  DATABASE_URL="postgres://openrecord:openrecord@localhost:5432/openrecord_dev" \
  PORT=3001 APP_BASE_URL="http://localhost:3000" OPENRECORD_LOCAL_BRIDGE=1 \
    nohup pnpm --filter @openrecord/api dev > /tmp/opencode-api.log 2>&1 &
fi

# 3. Web on :3000 (Vite hot-reloads; safe for live UI work).
if ! lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting web on :3000 (logs: /tmp/opencode-web.log)"
  nohup pnpm --filter @openrecord/web dev > /tmp/opencode-web.log 2>&1 &
fi

sleep 3
curl -s -o /dev/null -w "api:    %{http_code}\n" -X POST http://localhost:3001/api/auth/signin \
  -H "Content-Type: application/json" -d '{"email":"demo@northstar.test","password":"password123"}'
curl -s -o /dev/null -w "web:    %{http_code}\n" http://localhost:3000/
echo "ready → http://localhost:3000 (demo@northstar.test / password123)"
