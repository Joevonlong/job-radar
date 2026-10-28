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

The containers carry the shipped defaults inside their images (`/app/config`, copied from `config/` at build time; nothing
is mounted there). After editing a file in `config/`, `pnpm dev` and the host processes see it at once, the containers
only after a rebuild (`pnpm stack:up`, which is `docker compose up -d --build`). A build from the working tree uses
`.dockerignore`, which leaves out everything `.gitignore` ignores (`tests/ops/gitignore-coverage.sh` checks this with a
real Docker build); `scripts/ops/deploy.sh` instead builds from a `git archive` of the commit it deploys, setting
`JOB_RADAR_BUILD_CONTEXT` (`compose.yaml` falls back to `.` when it is unset), so uncommitted changes never reach a
deployed image.

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

`pnpm demo:shots` regenerates the pictures in `docs/images/` (the screenshots and the demo GIF in [features.md](features.md)) from a throw-away
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

`scripts/validate.sh` runs a syntax check of the shell scripts (`scripts/`, `scripts/ops/`, `scripts/ops/lib/` and the
shell tests under `tests/ops/`), the i18n catalog check (`pnpm i18n:check`), lint, typecheck, unit tests, config check, the
documentation link check, the CI documentation check (`pnpm ci:docs-check`) and the planning-id check
(`scripts/release-check.sh --planning-ids-only`: internal tracker ids such as `F-` / `B-` / `ADR-` numbers must not appear in the repository; a path whose id
is data goes into `scripts/planning-ids.allow`). User-visible text lives in `messages/*.json` (see [languages.md](languages.md)); after editing
a messages file run `pnpm i18n:catalog`. In addition:

```bash
pnpm test:integration   # needs a disposable Postgres (see below); creates and drops its own database
pnpm build && pnpm build:runner
pnpm test:e2e           # Playwright against a production build and a throw-away database
pnpm test:e2e:setup     # the first-run wizard on a brand-new install
```

The builds need no network: the fonts are self-hosted from the pinned `@fontsource` packages (`next/font/local` in
`src/app/layout.tsx` for the Latin families, the other subsets and Noto Sans SC in `src/app/globals.css`; licences in
`licenses/fonts/`). The image build runs them with `RUN --network=none`, so a change that fetches something at build
time fails there.

The database-backed tests (`test:integration`, `test:e2e`, `test:e2e:setup`) never use the database of your own installation,
and they have no default address that could lead there. Start a throw-away Postgres on a port of its own and point the
tests at it; the role must be allowed to create databases:

```bash
docker run --rm -d --name jobradar-test-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres postgres:17
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres   # E2E_ADMIN_DATABASE_URL also works for e2e
pnpm test:integration
docker rm -f jobradar-test-pg
```

Without `DATABASE_URL` the run stops at once and prints these commands. Each integration run creates and drops a database of
its own (`jobradar_test_*`); the e2e runs use `jobradar_e2e*` databases, and `scripts/e2e-prepare.ts` refuses to truncate or
seed any other name. Unit tests (`pnpm test`) need no database.

`E2E_PORT=<port>` gives the e2e run its own database, config and profile directories, so several checkouts can run in
parallel.

CI splits the main e2e suite across two independent runners: `E2E_PART=parallel pnpm test:e2e` runs `chromium` then
`chromium-exclusive`, and `E2E_PART=chain pnpm test:e2e` runs only the serial chain, keeping its dependency order. Only
the parallel CI part also runs `pnpm test:e2e:setup`. Unset `E2E_PART` runs the complete main suite in its original order;
any value other than `parallel` or `chain` is an error. File and line filters stay within the selected part.

To run only some e2e tests, name them: `pnpm test:e2e e2e/list-today.spec.ts` (one file), several files, or
`e2e/dashboard.spec.ts:206` (the test at that line). Only those tests run; the web server, the database preparation and
the stand-in runner start as for the full suite. This works for every spec, including the ones in the serial chain
(settings, interests, sources, market): `e2e/projects.ts` keeps just the projects with a named spec. `pnpm exec playwright
test <file>` behaves the same. `--project <name>` also runs that project's dependencies within the selected part (the
whole parallel suite first in full mode). Use `E2E_PART=chain` for the serial chain; `--no-deps` removes its serial
ordering. `--grep` on its own does not narrow the dependencies (every project before a matching
one runs in full): name the file as well. The named files are read from the command line unless `E2E_SPEC_FILTERS` is set in the
environment (a JSON list of filters, used to hand them to the workers): an exported value overrides the command line. The integration tests need `pg_dump` / `pg_restore` of the server's major version (17): set `PG_DUMP_PATH` /
`PG_RESTORE_PATH`, or use `scripts/ops/pg-docker.sh` symlinked as `pg_dump` and `pg_restore` (what CI does).

e2e specs import `test` and `expect` from `e2e/fixtures.ts` (lint enforces it): a reload or navigation there waits for
Server Actions still in flight, so a test can reload right after a click that saves. See "Projects of the main suite"
in [ci.md](ci.md#job-e2e) for the details and `E2E_SERVER_ACTION_DELAY_MS`, which exposes uncovered navigation paths and direct database reads (not bypassed imports; lint
covers those) and the coverage boundary of the guard.

What the CI runs, job by job, and how to run it locally: [ci.md](ci.md). Changing a workflow means updating that page
(`pnpm ci:docs-check` enforces it).

## Migrations

Edit `src/lib/db/schema.ts`, then `pnpm db:generate --name <slug>` and commit the generated SQL. CI fails when the
schema and `drizzle/` disagree. The runner applies migrations at start-up.

## The jobspy sidecar's dependencies

You edit two files: `jobspy/requirements.in` (the sidecar's direct dependencies, each pinned with `==`) and
`jobspy/requirements-dev.in` (the test tools on top). The lock files `jobspy/requirements.txt` and
`jobspy/requirements-dev.txt` are generated from them by pip-compile (pip-tools): every package, indirect ones included,
at a fixed version with the hashes of its files. Never edit them by hand. The image (`jobspy/Dockerfile`) and CI install
them with `pip install --require-hashes`, so a build gets exactly the versions CI tested, and pip refuses a file whose hash
changed or a package the lock does not list. The dev lock is constrained by the runtime one (`-c requirements.txt`), so
the tests run the image's versions. A unit test (`tests/dockerfile.test.ts`) fails when a pin in `requirements.in` is not
the version in the lock, i.e. when the lock was not regenerated.

After changing an `.in` file, regenerate both lock files with Python 3.12 (the image's version), runtime first:

```sh
python3.12 -m venv /tmp/pip-tools && /tmp/pip-tools/bin/pip install pip-tools
cd jobspy
/tmp/pip-tools/bin/pip-compile --generate-hashes --allow-unsafe --strip-extras --output-file requirements.txt requirements.in
/tmp/pip-tools/bin/pip-compile --generate-hashes --allow-unsafe --strip-extras --output-file requirements-dev.txt requirements-dev.in
```

Without options pip-compile keeps the versions already in the lock files; `--upgrade-package <name>` (or `--upgrade`)
moves indirect dependencies to newer releases. It downloads every file of every pinned release to hash it, so the first
run takes a few minutes. Dependabot (`pip`, `/jobspy`) works in this layout: its pull requests change the pin in the `.in`
file and regenerate the lock files.

The base image in `jobspy/Dockerfile` is pinned by digest (`python:3.12-slim@sha256:…`), so a rebuild starts from the
same Python and Debian packages; Dependabot (`docker`, `/jobspy`) proposes the next digest. The root `Dockerfile` keeps
its tags (`node:${NODE_VERSION}-slim`, the Playwright image of `PLAYWRIGHT_VERSION`): the build checks the Node version
against `engines.node`, and a unit test ties the Playwright image to `@playwright/test`.

## Before a public release

`scripts/release-check.sh` scans the working tree and the whole commit history for secrets (gitleaks, through Docker), for
personal information (names, machine paths, host names), for private planning ids anywhere in the repository, and checks that
`.gitignore` covers `.env`, `data/` and `.auth/`.
