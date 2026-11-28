#!/usr/bin/env bash
# Bring up the local dev stack: Postgres (Docker/Colima), API (:3001), web (:3000).
# Safe to re-run: it only starts what is missing, and restarts the API when it
# is serving an older commit than this checkout.
# Login afterwards: http://localhost:3000/signin — demo@northstar.test / password123
set -euo pipefail
cd "$(dirname "$0")/.."

# Local secrets and settings (hosted agent model, provider keys) live in the
# git-ignored .env; nothing else loads it, so the API and workers get it here.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
# Node from .nvmrc. The API hands its own Node to the bridge it runs, and the
# bridge (Cursor's SDK in particular) needs this version; nvm's default may be
# older, which silently leaves Cursor "not installed".
want_node="$(cat .nvmrc 2>/dev/null || true)"
if [ -n "$want_node" ] && ! node -v 2>/dev/null | grep -q "^v$want_node\."; then
  node_dir="$(ls -d "$HOME"/.nvm/versions/node/v"$want_node".* 2>/dev/null | sort -V | tail -1)"
  if [ -n "$node_dir" ]; then export PATH="$node_dir/bin:$PATH"
  else echo "WARNING: Node $want_node (.nvmrc) is not installed; run nvm install $want_node. The bridge needs it." >&2; fi
fi
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

# Starts a long-running process in its own session, so it outlives the shell
# that ran this script. nohup alone is not enough: a terminal tab, an editor
# task or an agent session that ends takes its whole process group with it,
# which is how the API kept stopping between turns. macOS has no setsid
# command, so perl (which it ships) starts the new session.
detach() {
  local log="$1"; shift
  perl -MPOSIX=setsid -e 'setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' "$@" < /dev/null > "$log" 2>&1 &
}

# Website setup has its own local worker so it can make progress without
# consuming queued provider calls or dispatching unrelated work.
setup_pid_file="/tmp/openrecord-setup-worker.pid"
setup_pid="$(cat "$setup_pid_file" 2>/dev/null || true)"
if [ -z "$setup_pid" ] || ! ps -p "$setup_pid" -o command= 2>/dev/null | grep -q '[s]rc/setup-only.ts'; then
  echo "starting setup worker (logs: /tmp/opencode-setup-worker.log)"
  DATABASE_URL="$DATABASE_URL" detach /tmp/opencode-setup-worker.log pnpm --filter @openrecord/worker exec tsx src/setup-only.ts
  echo "$!" > "$setup_pid_file"
fi

# Optional local workers, each started once and left alone while it runs.
start_worker() {
  local name="$1" script="$2" pid_file="/tmp/openrecord-$1-worker.pid" pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! ps -p "$pid" -o command= 2>/dev/null | grep -q "src/$script"; then
    echo "starting $name worker (logs: /tmp/opencode-$name-worker.log)"
    DATABASE_URL="$DATABASE_URL" detach "/tmp/opencode-$name-worker.log" pnpm --filter @openrecord/worker exec tsx "src/$script"
    echo "$!" > "$pid_file"
  fi
}
# AI-answer checks and re-checks ask real assistants and are billed by them, so
# they run only when asked for: OPENRECORD_CHECKS=1.
if [ "${OPENRECORD_CHECKS:-0}" = "1" ]; then
  start_worker checks checks-only.ts
else
  echo "AI checks and re-checks stay queued (paid calls); OPENRECORD_CHECKS=1 runs them"
fi
# Approved code-repository changes open their pull requests through this
# worker; it needs the GitHub execution settings in .env.
if [ -n "${GITHUB_EXECUTION_TOKEN:-}" ] && [ -n "${GITHUB_EXECUTION_REPOSITORIES:-}" ]; then
  start_worker execution execution-only.ts
fi

# Agent chat runs separately from HTTP and unrelated worker queues. Existing API
# processes may still own loops until their next idle restart; claims coordinate.
agent_worker_count="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM agent_worker_instances WHERE mode='standalone' AND stopped_at IS NULL AND heartbeat_at>now()-interval '30 seconds'")"
if [ "$agent_worker_count" -eq 0 ]; then
  echo "starting agent request worker (logs: /tmp/opencode-agent-worker.log)"
  DATABASE_URL="$DATABASE_URL" detach /tmp/opencode-agent-worker.log pnpm --filter @openrecord/api agent:worker
fi

# 2. API on :3001 (no watcher), run by a keeper loop that starts it again
# whenever it exits, and appends to its log so a crash's last words survive.
# Stop the API for good: kill "$(cat /tmp/openrecord-api-keeper.pid)" first.
api_keeper_pid_file="/tmp/openrecord-api-keeper.pid"
api_keeper_alive() {
  local pid; pid="$(cat "$api_keeper_pid_file" 2>/dev/null || true)"
  [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q '[o]penrecord-api-keeper'
}
# Restart it when it serves an older commit,
# but never deliberately interrupt an active turn (including helper sessions).
head_sha="$(git rev-parse --short=12 HEAD)"
if lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  running="$(curl -s -m 5 http://localhost:3001/api/health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  if [ "$running" != "$head_sha" ]; then
    active="$(psql "$DATABASE_URL" -tAc "SELECT (SELECT count(*) FROM agent_request_jobs WHERE status='RUNNING')+(SELECT count(*) FROM agent_conversations WHERE lease_until>now())")"
    if [ "$active" -gt 0 ]; then
      echo "WARNING: API is stale but agent work is active; leaving it running. Re-run when idle." >&2
    else
      echo "API serves ${running:-unknown}, checkout is $head_sha; restarting API"
      kill $(lsof -tiTCP:3001 -sTCP:LISTEN)
      while lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
      # A running keeper starts the new code by itself.
    fi
  fi
fi
#    OPENRECORD_LOCAL_BRIDGE=1: the API starts a bridge for the signed-in user
#    on this computer, so local CLI subscriptions work without pairing.
if ! api_keeper_alive && ! lsof -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting API on :3001 (logs: /tmp/opencode-api.log)"
  DATABASE_URL="$DATABASE_URL" \
  PORT=3001 APP_BASE_URL="http://localhost:3000" OPENRECORD_LOCAL_BRIDGE=1 AGENT_REQUEST_WORKER_ENABLED=false \
    detach /dev/null bash -c 'while :; do
      echo "[keeper] $(date "+%F %T") starting API"
      pnpm --filter @openrecord/api dev
      echo "[keeper] $(date "+%F %T") API exited with status $?; starting it again in 5s"
      sleep 5
    done >> /tmp/opencode-api.log 2>&1' openrecord-api-keeper
  echo "$!" > "$api_keeper_pid_file"
fi

# 3. Web on :3000 (Vite hot-reloads code changes; restart it by hand after a
#    dependency change). OPENRECORD_WEB=0 skips it when only the desktop app is used.
web=1; [ "${OPENRECORD_WEB:-1}" = "0" ] && web=0
if [ "$web" = 1 ] && ! lsof -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "starting web on :3000 (logs: /tmp/opencode-web.log)"
  detach /tmp/opencode-web.log pnpm --filter @openrecord/web dev
fi

for _ in $(seq 1 90); do
  running="$(curl -s -m 5 http://localhost:3001/api/health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  [ "$running" = "$head_sha" ] && { [ "$web" = 0 ] || curl -sf -m 5 -o /dev/null http://localhost:3000/; } && break
  sleep 1
done
curl -s -m 5 -o /dev/null -w "api:    %{http_code}\n" -X POST http://localhost:3001/api/auth/signin \
  -H "Content-Type: application/json" -d '{"email":"demo@northstar.test","password":"password123"}'
[ "$web" = 1 ] && curl -s -m 5 -o /dev/null -w "web:    %{http_code}\n" http://localhost:3000/
running="$(curl -s -m 5 http://localhost:3001/api/health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
echo "commit: API $running, checkout $head_sha ($(git rev-parse --abbrev-ref HEAD)), origin/main $(git rev-parse --short=12 origin/main)"
echo "ready → http://localhost:3000 (demo@northstar.test / password123)"
echo "desktop → OPENRECORD_API_URL=http://localhost:3001 ./scripts/desktop-dev.sh  (native app; rebuild required for Rust UI)"
