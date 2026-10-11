#!/usr/bin/env bash
# The product's own checks: shell syntax of the operations scripts, the i18n catalog (messages files), lint, typecheck, unit tests, configuration check
# (shipped defaults), documentation link check, CI documentation check (docs/ci.md vs the workflows), planning-id check. Used by contributors and by CI. Integration and e2e tests are separate
# (`pnpm test:integration`, `pnpm test:e2e`).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "== dependencies"
if [[ ! -d node_modules ]]; then pnpm install --frozen-lockfile; else echo "node_modules present"; fi

echo "== shell scripts"
for f in scripts/*.sh scripts/ops/*.sh; do bash -n "$f"; done

echo "== i18n catalog"
pnpm i18n:check
echo "== lint"
pnpm lint
echo "== typecheck"
pnpm typecheck
echo "== unit tests"
# Unit tests have no database; an unreachable URL (never the compose default, never a DATABASE_URL from the shell)
DATABASE_URL=postgres://nobody:x@127.0.0.1:1/none pnpm test
echo "== config"
pnpm config:check
echo "== docs links"
pnpm docs:check
echo "== CI docs (docs/ci.md matches the workflows)"
pnpm ci:docs-check
echo "== planning ids (no internal tracker ids in the repository)"
scripts/release-check.sh --planning-ids-only

echo "validate passed"
