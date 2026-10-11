<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Job Radar: guide for coding agents

A self-hosted job search radar: Next.js 16 web, a runner process, a Python scraping sidecar (`jobspy/`), Postgres, and a
host `ai-worker`. Read [README.md](README.md) first, then [docs/development.md](docs/development.md).

## Commands

- `pnpm install`, then `scripts/validate.sh` (lint, typecheck, unit tests, config check, docs link check).
- `pnpm test:integration`, `pnpm test:e2e` and `pnpm test:e2e:setup` need a disposable Postgres where the role may create
  databases, given as `DATABASE_URL` (e2e also accepts `E2E_ADMIN_DATABASE_URL`). They have no default address and never
  fall back to the local installation's database (`127.0.0.1:5433`): without one they stop and print the command, e.g.
  `docker run --rm -d --name jobradar-test-pg -p 127.0.0.1:55432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:17`
  and `export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`. e2e runs Playwright against a production
  build and its own throw-away database (`E2E_PORT=<port>` isolates it); `scripts/e2e-prepare.ts` refuses any database
  whose name does not start with `jobradar_e2e`.
- `pnpm build`, `pnpm build:runner`, `pnpm db:generate --name <slug>` for migrations.
- `scripts/release-check.sh` before anything is published.
- `pnpm ci:docs-check` (also in `scripts/validate.sh`) after touching `.github/`; the CI is explained in `docs/ci.md`.

## Rules

1. Raw postings are stored before parsing; a parse failure keeps the payload. One channel failing never stops a cycle.
2. Facts a posting does not state are `unknown`; AI judgements stay in their own tables; signals carry a JD quote.
3. TypeScript strict, no `any`, no `@ts-ignore`; zod at every external boundary (HTTP, email, AI output, config, forms).
4. Database access only in `src/lib/db/`.
5. Thresholds, budgets, times, keywords, countries, currencies are configuration (`config/*.yaml` defaults, user layer
   `data/config/`), never hard-coded. Nothing owner-specific (paths, names, cities) in code, config defaults or tests.
6. User-visible text only in `messages/{en,zh}.json`; no internal tracking ids (`F-`, `B-`, `ADR-`, `M-`, `P-` numbers) anywhere in the repository, in docs, comments, test names or log lines; `scripts/validate.sh` fails on them.
7. Secrets only in `.env` and `.auth/` (gitignored); never read their values, never print or commit them. Personal
   data (`data/`) never goes into the repository.
8. Tests build the configuration they need; they never assert values of the shipped `config/*.yaml`. They never default
   to a real resource (the installation's database, directories or ports): a missing test database is an error, and tests
   use disposable ones and clean up.
9. Docs: English first, Chinese counterpart as `*.zh.md`. Changing a page, channel or config format updates `docs/`.
10. Changing a workflow under `.github/workflows/` (a job, a step or its name, `dependabot.yml`) means updating `docs/ci.md` and `docs/ci.zh.md` in the same PR; `pnpm ci:docs-check` (part of `scripts/validate.sh`, and the `ci-docs` job) fails otherwise. Every workflow step needs a `name:`.
11. Never run `docker compose down -v` or touch the `jobradar` volume of a running installation.

