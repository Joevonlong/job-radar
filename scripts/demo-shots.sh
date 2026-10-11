#!/usr/bin/env bash
# README screenshots and demo GIF: `pnpm demo:shots [--env-sentinel] [--require-patterns | --allow-missing-patterns]`
# (docs/images/README.md).
#
# Needs DEMO_ADMIN_DATABASE_URL: a Postgres server where the role may CREATE DATABASE (e.g. the compose db). Only a
# database named jobradar_demo* (DEMO_DB_NAME, default jobradar_demo) is created and dropped there; the config and
# profile live in temp directories. The project's .env and data/ are never read. Port: DEMO_PORT (default 3190).
#
#   1. Playwright (playwright.shots.config.ts): prepares the demo instance, builds and starts the app, checks the
#      environment is clean, takes the pictures (leak guard first) and records the GIF's video.
#   2. scripts/demo-finish.ts: GIF + local mp4, PNG budget, move to docs/images/.
#   3. Always: drop the demo database and remove the temp directories.
#
# --require-patterns (the default): the leak guard must load the private patterns (.release-check.local here or in the
# main checkout, or RELEASE_CHECK_PATTERNS_FILE); without them the run fails before any picture. Pictures meant for a
# commit are made this way. --allow-missing-patterns: a contributor without the file; the guard warns and uses only
# its generic rules.
# --env-sentinel (only when there is no .env): writes a .env whose every value is a sentinel string, runs, and checks
# the sentinel appears nowhere (the guard fails on it); the .env is removed afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DEMO_ADMIN_DATABASE_URL:?set DEMO_ADMIN_DATABASE_URL (a Postgres server where the role may CREATE DATABASE)}"

sentinel_env=""
DEMO_REQUIRE_PATTERNS=1
for arg in "$@"; do
  case "$arg" in
    --require-patterns) DEMO_REQUIRE_PATTERNS=1 ;;
    --allow-missing-patterns) DEMO_REQUIRE_PATTERNS=0 ;;
    --env-sentinel)
      if [ -e .env ]; then
        echo "demo:shots: --env-sentinel needs a checkout without .env (it never touches an existing one)" >&2
        exit 2
      fi
      DEMO_ENV_SENTINEL="demo-env-sentinel-$(date +%s)-$$"
      export DEMO_ENV_SENTINEL
      grep -oE '^#? ?[A-Z][A-Z0-9_]*=' .env.example | sed -E 's/^#? ?//; s/=$//' | sort -u | while read -r name; do
        printf '%s=%s\n' "$name" "$DEMO_ENV_SENTINEL"
      done > .env
      sentinel_env=".env"
      ;;
    *)
      echo "usage: pnpm demo:shots [--env-sentinel] [--require-patterns | --allow-missing-patterns]" >&2
      exit 2
      ;;
  esac
done

export DEMO_REQUIRE_PATTERNS

cleanup() {
  status=$?
  pnpm exec tsx scripts/demo-prepare.ts --drop || status=1
  if [ -n "$sentinel_env" ]; then rm -f "$sentinel_env"; fi
  exit "$status"
}
trap cleanup EXIT

rm -rf .local-demo/staging .local-demo/video .local-demo/test-results
pnpm exec playwright test --config playwright.shots.config.ts
pnpm exec tsx scripts/demo-finish.ts
