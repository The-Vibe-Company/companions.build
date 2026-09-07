#!/bin/sh
set -eu

role="${1:-api}"
if [ "$#" -gt 0 ]; then shift; fi
case "$role" in
  api) exec bun apps/server/src/api.ts "$@" ;;
  executor) exec bun apps/server/src/executor.ts "$@" ;;
  worker) exec bun apps/server/src/worker.ts "$@" ;;
  migrate) exec bun apps/server/src/migrate.ts "$@" ;;
  *) echo "Unknown role: $role (expected api, executor, worker, or migrate)" >&2; exit 64 ;;
esac
