#!/usr/bin/env bash
# Runs a PostgreSQL client tool (pg_dump / pg_restore) from the postgres image instead of an apt-installed client,
# so CI does not depend on apt.postgresql.org. Reached through symlinks named after the tool: pg_dump, pg_restore.
# Env: PG_DOCKER_IMAGE (default postgres:17), PG_DOCKER_NETWORK (default host: the service port is on localhost).
set -euo pipefail
tool=$(basename "$0")
case "$tool" in
  pg_dump | pg_restore) ;;
  *) echo "pg-docker.sh: call it as pg_dump or pg_restore (got $tool)" >&2; exit 2 ;;
esac
exec docker run --rm -i --network "${PG_DOCKER_NETWORK:-host}" -e PGPASSWORD \
  "${PG_DOCKER_IMAGE:-postgres:17}" "$tool" "$@"
