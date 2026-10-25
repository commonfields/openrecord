#!/usr/bin/env bash
# OpenRecord hosted pilot: prepare deploy/.env's version identification from
# the checked-out commit, so a running deployment can state what it serves
# (/api/dev/runtime -> commitSha; image labels). Never prints or stores
# secrets; only rewrites the OPENRECORD_BUILD_COMMIT line in deploy/.env.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
if [ -z "$commit" ]; then
  echo "not a git checkout; set OPENRECORD_BUILD_COMMIT manually in deploy/.env" >&2
  exit 1
fi
env_file="$root/deploy/.env"
if [ ! -f "$env_file" ]; then
  echo "deploy/.env is missing; copy deploy/.env.example first" >&2
  exit 1
fi
if grep -qE '^OPENRECORD_BUILD_COMMIT=' "$env_file"; then
  sed -i.bak "s/^OPENRECORD_BUILD_COMMIT=.*/OPENRECORD_BUILD_COMMIT=$commit/" "$env_file" && rm -f "$env_file.bak"
else
  printf '\nOPENRECORD_BUILD_COMMIT=%s\n' "$commit" >> "$env_file"
fi
echo "deploy/.env now identifies the deployment as commit ${commit:0:12}"
