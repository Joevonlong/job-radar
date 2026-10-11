# Development

Notes for contributors. See also [CONTRIBUTING.md](../CONTRIBUTING.md) and the root `AGENTS.md`.

## Layout

- `src/app/` Next.js 16 app (App Router): pages, API routes, server actions. Next.js 16 differs from older versions; read
  `node_modules/next/dist/docs/` before using its APIs.
- `src/runner/` the scheduler / collector process (container); `src/ai-worker/` the host AI process.
- `src/lib/` domain code: `channels/` (one folder per source), `pipeline/` (normalize, de-duplicate, lifecycle),
  `filter/`, `signals/`, `scoring/`, `ai/` (provider layer), `notify/` (Telegram), `cycle/` (processing cycle steps),
  `config/` (zod schemas and loaders), `db/` (schema, queries, repos), `ops/` (backup, doctor, disk, logs), `settings/`.
- `config/` shipped default configuration; `jobspy/` the Python scraping sidecar; `drizzle/` SQL migrations;
  `messages/{en,zh}.json` every user-visible string; `scripts/` CLI helpers, `scripts/ops/` operations scripts.

## Rules that shape the code

1. The raw posting is stored first; parse failures keep the payload.
2. A channel failure only affects that channel.
3. Facts the posting does not state are `unknown`; AI judgements live in their own tables.
4. Secrets only in `.env` and `.auth/`, never in logs or error messages.
5. Personal data stays local.
6. TypeScript strict, no `any`, zod at every external boundary (HTTP, email, AI output, configuration, forms).
7. Signals must carry a quote from the job description.
8. Thresholds, budgets, times, keywords, countries, currencies and user-visible text are configuration or messages,
   never hard-coded. Tests build the configuration they need; they never assert values of the shipped `config/*.yaml`.
9. Database access only in `src/lib/db/`.

## Running things

```bash
pnpm install
docker compose up -d db            # Postgres on 127.0.0.1:5433 for host-side tools
pnpm db:migrate
pnpm db:seed                       # ~20 fictional postings for UI work
pnpm dev                           # dashboard on http://localhost:3000
pnpm runner                        # collector on the host (optional)
pnpm ai-worker                     # host AI worker (optional)
pnpm cycle:run --channel fixture --dry-run   # rehearse a cycle on the fixture channel
```

## Try it with sample data

To look around without your own data or any API key:

```bash
docker compose up -d db
pnpm db:migrate
pnpm db:seed                       # fictional companies, jobs, runs and a few applications
pnpm config:example ai-engineering-europe   # optional: a ready-made search setup
pnpm dev                           # open http://localhost:3000
```

The first visit may open the setup; every step can be skipped. `pnpm db:seed` only replaces what an earlier seed wrote.

## README screenshots

`pnpm demo:shots` regenerates the pictures in `docs/images/` (the README screenshots and the demo GIF) from a throw-away
instance with fictional data: its own `jobradar_demo` database, config and profile in temp directories, and an empty
environment (your `.env` and `data/` are never read). It needs ffmpeg and a Postgres server where the role may create a
database:

```bash
DEMO_ADMIN_DATABASE_URL=postgres://jobradar:<password>@127.0.0.1:5433/postgres pnpm demo:shots
```

Before any picture is written, a guard checks the page markup and responses for machine paths, the user and host name,
real-looking e-mail addresses and the strings of `.release-check.local` (required by default, also found from a git
worktree; `--allow-missing-patterns` to run without); a hit stops the run. The guard does not read JS, CSS, fonts,
canvas, iframes or image pixels, and only `.env.example` variable names are blanked for the server. The run builds into
the repository's `.next/`, so don't run it next to `pnpm dev` / `pnpm start`. Details, names and budgets:
[images/README.md](images/README.md). It is not part of `pnpm test:e2e`.

## Checks

`scripts/validate.sh` runs the i18n catalog check (`pnpm i18n:check`), lint, typecheck, unit tests, config check, the
documentation link check, the CI documentation check (`pnpm ci:docs-check`) and the planning-id check
(`scripts/release-check.sh --planning-ids-only`: internal tracker ids such as `F-` / `B-` / `ADR-` numbers must not appear in the repository; a path whose id
is data goes into `scripts/planning-ids.allow`). User-visible text lives in `messages/*.json` (see [languages.md](languages.md)); after editing
a messages file run `pnpm i18n:catalog`. In addition:

```bash
pnpm test:integration   # needs the compose db; creates and drops its own database
pnpm build && pnpm build:runner
pnpm test:e2e           # Playwright against a production build and a throw-away database
```

`E2E_PORT=<port>` gives the e2e run its own database, config and profile directories, so several checkouts can run in
parallel.

To run only some e2e tests, name them: `pnpm test:e2e e2e/list-today.spec.ts` (one file), several files, or
`e2e/dashboard.spec.ts:206` (the test at that line). Only those tests run; the web server, the database preparation and
the stand-in runner start as for the full suite. This works for every spec, including the ones in the serial chain
(settings, interests, sources, market): `e2e/projects.ts` keeps just the projects with a named spec. `pnpm exec playwright
test <file>` behaves the same. `--project <name>` also runs that project's dependencies (the whole parallel suite first);
add `--no-deps` to skip them. `--grep` on its own does not narrow the dependencies (every project before a matching
one runs in full): name the file as well. The named files are read from the command line unless `E2E_SPEC_FILTERS` is set in the
environment (a JSON list of filters, used to hand them to the workers): an exported value overrides the command line. The integration tests need `pg_dump` / `pg_restore` of the server's major version (17): set `PG_DUMP_PATH` /
`PG_RESTORE_PATH`, or use `scripts/ops/pg-docker.sh` symlinked as `pg_dump` and `pg_restore` (what CI does).

What the CI runs, job by job, and how to run it locally: [ci.md](ci.md). Changing a workflow means updating that page
(`pnpm ci:docs-check` enforces it).

## Migrations

Edit `src/lib/db/schema.ts`, then `pnpm db:generate --name <slug>` and commit the generated SQL. CI fails when the
schema and `drizzle/` disagree. The runner applies migrations at start-up.

## Before a public release

`scripts/release-check.sh` scans the working tree and the whole commit history for secrets (gitleaks, through Docker), for
personal information (names, machine paths, host names), for private planning ids anywhere in the repository, and checks that
`.gitignore` covers `.env`, `data/` and `.auth/`.
