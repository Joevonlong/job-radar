# Continuous integration explained

[English](ci.md) | [中文](ci.zh.md)

This page explains every job and step of the GitHub Actions pipeline (`.github/workflows/ci.yml`): what it does, which
tests it runs and why, how long it takes, how to run it on your own machine, and how to read a failure. It is written for
contributors and maintainers.

**This page is bound to the pipeline.** `pnpm ci:docs-check` (part of `scripts/validate.sh`, and the `ci-docs` job of the
pipeline itself) fails when a job or step of a workflow has no section here, when this page documents one that no longer
exists, or when [ci.zh.md](ci.zh.md) lists different jobs or steps. Change the pipeline, change this page (and its `.zh`
mirror) in the same pull request. The rules for the headings are at the end, under [Keeping this page true](#keeping-this-page-true).

Durations are typical values on the GitHub-hosted `ubuntu-24.04` runner (2 cores); the run summary of each pull request
shows the real numbers. The page deliberately states no test counts and no action versions: they change with every pull
request or Dependabot update, and the workflow file and the test folders are the source of truth.

## At a glance

```mermaid
flowchart LR
  PR([pull request / push to main / manual run]) --> changes
  PR --> ci-docs
  PR --> static
  PR --> unit
  changes -- code changed --> integration
  changes -- code changed --> e2e
  changes -- code changed --> linux-smoke
  changes --> ci-ok
  ci-docs --> ci-ok
  static --> ci-ok
  unit --> ci-ok
  integration --> ci-ok
  e2e --> ci-ok
  linux-smoke --> ci-ok
  ci-ok --> merge([the one required check])
```

All jobs run side by side; the run takes as long as the slowest one (the end-to-end job, about 10 to 12 minutes) rather
than the sum. `ci-ok` is the single check a branch protection rule should require: it passes only when every job the
classifier selected succeeded.

Which jobs run depends on what the change touches (decided by the `changes` job):

| Change | Jobs that run |
|---|---|
| Pull request that changes only documentation (`*.md`, `*.html`, images; never anything under `tests/`) | `changes` (with the documentation link check), `ci-docs`, `static`, `unit`, `ci-ok`. Several unit tests read the documentation (link targets, picture sizes), so they run. |
| Any other pull request (code, scripts, config, anything under `tests/`, workflows, Dockerfiles) | the above plus `integration`, `e2e` and `linux-smoke` |
| Push to `main` | always everything, whatever the pushed commits touch; `integration` also runs the default file order |
| Manual run (`workflow_dispatch`) | everything, like a push to `main` |

A job the classifier did not select (`integration`, `e2e`, `linux-smoke` on a documentation-only pull request) shows as
"skipped" and `ci-ok` accepts exactly that; a job that must run and was skipped, cancelled or failed makes `ci-ok` fail.

Workflow-level settings: `permissions: contents: read` (no job can write to the repository; pull requests from forks run
without secrets), a `concurrency` group per ref (a new push cancels the older run of a pull request, never a run on
`main`), and every job and step has a `timeout-minutes` so a hung step fails instead of sitting for hours.

## Reading a failed run

1. Open the pull request, look at the checks list: `ci-ok` is red whenever any job is red. The red job is the one to open.
2. In the job, the red step is expanded. Pull-request annotations (`::error::` lines, Playwright's `github` reporter) also
   appear on the "Files changed" tab and in the run summary.
3. For `e2e` the artifact `playwright-report` (kept 7 days) holds the HTML report and the traces of failed tests of the
   main suite (`playwright-report/`) and of the setup wizard suite (`playwright-report-setup/`); open one with
   `pnpm exec playwright show-report playwright-report` (or `playwright-report-setup`), or a single trace with
   `pnpm exec playwright show-trace <trace.zip>`.
4. A test that passed only on its retry fails the job on purpose (`--fail-on-flaky-tests`): fix the flakiness, do not
   re-run until green.
5. Re-run a failed job from the run page ("Re-run failed jobs") only when the cause is clearly the runner (network,
   cache service), never to get past a failing test.

The sections below give the commonly seen causes per step.

## Jobs

### Job `changes`

Decides which of the other jobs are needed and checks the relative links of the documentation. Runs for every change.
Limit 5 minutes, typically under 20 seconds.

#### Check out the repository

`actions/checkout` with `fetch-depth: 0` (the whole history, because the classifier diffs two commits). Fails only on
GitHub outages.

#### Classify the change

Only a pull request is classified; it writes two outputs that the other jobs read:

- `code`: `true` unless every changed file is documentation (`*.md`, `*.html`, `png`, `jpg`, `svg`, `gif`). Anything
  under `tests/` is code even when it is an HTML file or an image: the tests read their fixtures. Scripts, YAML,
  Dockerfiles and workflows are code as well. `code` selects `integration`, `e2e` and `linux-smoke`; `static` and `unit`
  run either way (the unit tests read the documentation, and no list of "which tests read which file" is kept that
  could go stale).
- `full`: `true` on pushes to `main` and manual runs; it adds the default-order integration run.

A push to `main` and a manual run are not classified at all: both write `code=true` and `full=true`. The commits on `main`
are what gets deployed, so a documentation-only push must not end in a run that checked nothing. The range of a pull
request is `base...head`. If the diff cannot be computed the step fails (and so does `ci-ok`): there is no silent "nothing
changed". Run it by hand: `git diff --name-only origin/main...HEAD`, then look for a path that is not `*.md`, `*.html` or
an image, or that starts with `tests/`.

#### Documentation links

`node scripts/check-doc-links.mjs` (also `pnpm docs:check`, and part of `scripts/validate.sh`). Checks that every relative
link in the Markdown files and every `href` / `src` of the HTML guides points to an existing file; anchors and absolute
URLs are not followed. About 5 seconds. A failure lists `file -> target`. Typical causes: a renamed or deleted doc, a
typo in a relative path.

### Job `ci-docs`

Runs `pnpm ci:docs-check`, which keeps this page and the pipeline in step. It is a separate job so that it also runs for
documentation-only changes (removing a heading of this page is a documentation-only change). About 1 minute, most of it
the dependency install (cached).

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`: installs the pnpm version pinned in `packageManager` of `package.json`.

#### Set up Node.js

`actions/setup-node`, Node 22 (the version in `engines`), with the pnpm store cached by the hash of `pnpm-lock.yaml`.

#### Install dependencies

`pnpm install --frozen-lockfile`. Fails when `package.json` and `pnpm-lock.yaml` disagree: run `pnpm install` locally and
commit the lockfile. The same step appears in every job that runs project code and is not explained again below.

#### CI documentation matches the workflows

`pnpm ci:docs-check` (`scripts/check-ci-docs.ts`). Parses every file under `.github/workflows/`, requires a `name:` on
every step, and compares jobs and steps with the headings of `docs/ci.md`; it also compares the job and step headings of
`docs/ci.zh.md` with `docs/ci.md`, and checks that every Dependabot ecosystem is named in the [Dependabot](#dependabot)
section. Every message says which heading to add, rename or remove. Its own tests are `tests/ops/ci-docs-check.test.ts`.
Run locally: `pnpm ci:docs-check` (a second or two).

### Job `static`

The checks that need no database and no browser: generated files, lint, types, configuration, shell syntax, the runner
bundle, migration drift and the Python sidecar tests. Runs for every change. Limit 15 minutes, typically 4 to 6
minutes (install, lint and typecheck dominate). All of it except the runner bundle, migration drift and the sidecar
tests is also in `scripts/validate.sh`.

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile` (see `ci-docs`).

#### I18n catalog (messages valid, generated files current)

`pnpm i18n:check` (`tsx scripts/i18n-catalog.ts --check`). Validates every `messages/<id>.json` (the core languages `en` and `zh` have every key, other languages have no key English lacks, every message uses the
same placeholders as the English one) and verifies that the generated catalog files are what the generator would write now. Failure
text names the key or file. Fix: edit the messages, then `pnpm i18n:catalog` and commit the regenerated files. A few
seconds.

#### Lint

`pnpm lint` (`eslint .`). Whole repository, including tests and scripts. Failures print `file:line rule`. Fix locally with
`pnpm lint --fix` where the rule allows it. About 1 minute.

#### Typecheck

`pnpm typecheck` (`tsc --noEmit`, strict mode, all of `src`, `tests`, `scripts`, `e2e`). Catches type errors and the
broken imports behind them. About 1 minute.

#### Config check

`pnpm config:check` (`tsx scripts/config-check.ts`). Validates every shipped default in `config/` against its schema and
`config_version`, every market pack, and the cross-file references (for example that the market of `preferences.yaml`
resolves). A few seconds. Typical cause: a config edit that violates its zod schema. See
[configuration.md](configuration.md).

#### Shell script syntax

`for f in scripts/*.sh scripts/ops/*.sh; do bash -n "$f"; done`. A parse-only check of the operations scripts (deploy,
backup, restore, worker installers, validate). The scripts' behaviour is tested in `tests/ops/`. Instant.

#### Runner bundle

`pnpm build:runner`: bundles the collector (`src/runner/index.ts`, `src/runner/healthcheck.ts`) with esbuild into `dist/`,
exactly as the Dockerfile `runner` target does. The e2e job uses a stand-in runner, so this is the only place where a
broken import in the real runner entry point is caught before the image build. About 20 seconds.

#### Migration drift

Runs `pnpm exec drizzle-kit generate` and fails if it changes anything under `drizzle/`: the schema in
`src/lib/db/schema.ts` must match the committed migrations. The failure prints the changed files and
`::error::src/lib/db/schema.ts and drizzle/ disagree`. Fix: `pnpm db:generate --name <slug>` and commit the generated SQL
and the journal in `drizzle/meta`. Do not edit generated SQL by hand to silence it.

#### Set up Python

`actions/setup-python`, Python 3.12, with the pip cache keyed on `jobspy/requirements*.txt`.

#### Install jobspy sidecar dependencies

`python -m pip install -r requirements-dev.txt` in `jobspy/`. Installs the sidecar's runtime and test dependencies.
Locally use a virtual environment: `python3.12 -m venv .venv && .venv/bin/pip install -r jobspy/requirements-dev.txt`.

#### Jobspy sidecar tests

`python -m pytest -q` in `jobspy/` (the tests in `jobspy/tests/`, with the scraping library mocked: request
validation, result mapping and error handling of the small HTTP service in `jobspy/app.py`). Seconds. Typical cause: a
change to `jobspy/app.py` without the matching test, or a dependency bump.

### Job `unit`

The Vitest unit suite: every test under `tests/**` except `tests/integration/`, jsdom for components and the node
environment for server code. The suite takes about 4 minutes in one piece, so it is split with Vitest's `--shard` into
two jobs, `unit (1/2)` and `unit (2/2)`, that run in parallel (about 2 to 3 minutes each). `fail-fast` is off, so both
shards always report. Runs for every change, documentation-only pull requests included: some tests read the repository's
documentation (the headings the in-app help links to, the pictures the README shows and their sizes). Limit 15 minutes.

These tests need no database, no network and no real clock: time is injected or faked, config is built per test in a
temporary directory, and the frozen fixture in `tests/fixtures/config/defaults/` replaces the shipped `config/` (tests never
assert values of the shipped defaults).

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile`.

#### Unit tests

`pnpm test --shard=<n>/2`, that is `vitest run` for half of the files. Locally run everything with `pnpm test`, one file
with `pnpm test tests/ops/backup.test.ts`, or one test with `-t "<name>"`. The shard a file lands in is decided by Vitest from
the file list, so a failing file may move between shards when files are added. The failure output is Vitest's: the
test name, the diff of expected and actual, and the line. Common causes: an unmocked clock, a test that depends on the
time zone or on another test's leftovers (re-run the file alone to tell), a snapshot of text that changed with the messages.

### Job `integration`

Tests that need a real PostgreSQL 17: repositories and migrations, the cycle and queues, the control requests, the
ai-worker, the dashboard queries, backups with the real `pg_dump` / `pg_restore`. The files under
`tests/integration/`, run through `vitest.integration.config.ts` (node environment, files one after another because they share one
database that is emptied before and after every file). Limit 20 minutes, typically 3 to 4 minutes.

The job has a `postgres:17` service container and the environment `DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres`.
The role may create databases: every run creates a uniquely named database (`tests/integration/global-setup.ts`) and
drops it at the end, so nothing else on the server is touched. The tests have no default server: without
`DATABASE_URL` the run stops at once and prints the command for a disposable container, so a local run can never end up
in the database of your own installation. `REQUIRE_PG_TOOLS=1` makes the backup tests fail instead
of skipping when the client tools are missing.

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile`.

#### Provide PostgreSQL 17 client tools

Creates `pg_dump` and `pg_restore` as symlinks to `scripts/ops/pg-docker.sh`, which runs the tool from the `postgres:17`
image in a `--network host` container (so `localhost:5432` is reachable). The server and the client must have the same
major version; taking the tools from the image already pulled for the service avoids `apt.postgresql.org`, which once
hung this step for an hour. It prints both versions as a smoke test. Locally, on Linux, do the same
(`ln -sf "$PWD/scripts/ops/pg-docker.sh" /tmp/pgbin/pg_dump`, same for `pg_restore`) and export `PG_DUMP_PATH`,
`PG_RESTORE_PATH`; on macOS (Docker Desktop has no host networking) install PostgreSQL 17 client tools (for example
`brew install postgresql@17`) and point the two variables at them.

#### Integration tests (default order)

`pnpm test:integration --reporter=verbose`, only when `full` is true (pushes to `main`, manual runs). The verbose
reporter prints each file as it starts, so a hung file is named. Limit 15 minutes. Run locally with a database as
described in [Running the whole pipeline locally](#running-the-whole-pipeline-locally).

#### Integration tests (shuffled file order)

Runs the same suite with `--sequence.shuffle.files --sequence.seed=<seed>`; the seed is printed as a `::notice::`
annotation (`integration file order seed: N`). Pull requests run only this order: it finds files that depend on
another file's leftovers, which a fixed order hides. To reproduce a failure, run
`pnpm test:integration --sequence.shuffle.files --sequence.seed=<seed>` with the seed from the annotation. Limit 15 minutes.

### Job `e2e`

The Playwright browser suite against a production build (`pnpm build` then `pnpm start`), a throwaway PostgreSQL 17 service
and a stand-in runner (`scripts/e2e-runner.ts`: heartbeat, config acknowledgement and control-request polling, so
"run a cycle now" and "config saved" work without a real collector). No AI provider, no job channel and no network
beyond localhost. The specs under `e2e/` plus the ones in `e2e-setup/`. Limit 20 minutes, typically 10 to 12 minutes in
total. The job runs in the runner host, not in the Playwright container image (measured: the image
was slower).

What the environment looks like: `DATABASE_URL` points at the service (a local run must set `DATABASE_URL` or
`E2E_ADMIN_DATABASE_URL` itself: there is no default address); `scripts/e2e-prepare.ts`, which refuses any database whose
name does not start with `jobradar_e2e`, creates the database
`jobradar_e2e_3100` (the name follows `E2E_PORT`), applies the migrations and loads the dashboard seed (fictional postings), and fills a fresh
config and profile directory from the frozen fixture in `tests/fixtures/config/defaults/`. `E2E_PORT=3100` is the server
port; `E2E_SKIP_BUILD=1` tells the web server command not to build again.

**Projects of the main suite (`playwright.config.ts`).** The specs do not all run the same way:

The projects are planned in `e2e/projects.ts` (unit-tested by `tests/e2e-projects.test.ts`, which also checks with
`playwright test --list` that a named spec runs alone).

- `chromium` runs most specs fully in parallel (2 workers on the 2-core runner), each in its own browser context. It
  ignores every spec that writes shared configuration and every test tagged `@exclusive`.
- `chromium-exclusive` runs the tests tagged `@exclusive`, one at a time (`workers: 1`), after `chromium` has finished.
  All specs share one seeded database, and the parallel ones change it as they go: opening a detail page marks the job
  seen, a visit to Today moves the "last visit" marker, tests ignore, close and star jobs (and put them back), the scoring
  spec adds a job for a while. A test that changes state every page reads (the visit marker, the seen rows of all jobs:
  `list-today.spec.ts`) or that compares counts of the whole list (the `/jobs` filter counts in `dashboard.spec.ts`, the
  filtered toggle in `filter.spec.ts`, the headline numbers of `insights.spec.ts`) gets the tag. A test that changes one
  job uses a job no other spec touches and puts it back, and asserts only on that job; it stays parallel.
- The specs that rewrite a file of the one shared config directory (settings, language, breakdown, resume, interests,
  sources, market) would corrupt each other, or break the assertions of parallel specs that read those settings (the AI
  cards on the Sources page, the UI language). They therefore run as single-spec projects chained with `dependencies`, one
  after another and only after `chromium-exclusive` has finished. First the config chain: `chromium-config-settings`,
  `-settings-invalid`, `-language`, `-breakdown`, `-resume`. Then the interests chain: `chromium-interests`,
  `chromium-interests-suggestions` and `chromium-multi-filters` (all save views or accepted suggestions to the one
  `interests.yaml`). Then `chromium-sources-registry` and `chromium-sources-discovery` (both rewrite `sources.yaml`), then
  `chromium-settings-advanced` and `chromium-settings-workflow` (the advanced editor and the workflow tab rewrite ui, notify,
  ai, sources and pipeline config), and last `chromium-market` (switching the market changes every page and
  `preferences.yaml`). The chain is the reason the total is not `slowest spec / 2`: it is serial by design.
- A new spec that writes any file of the config directory must be added to `SERIAL_CHAIN` in `e2e/projects.ts` (its
  own chained project); otherwise it will fail randomly in parallel with other specs. A new test that changes shared
  database state or counts whole lists gets `{ tag: EXCLUSIVE_TAG }`.
- Spec files named on the command line (`pnpm test:e2e e2e/settings.spec.ts`) run alone: only the projects with a
  matching spec take part, each narrowed to the named specs and still in the order above. (Playwright runs a dependency
  project in full, so without this a chained spec would first run the whole parallel suite.) With a `file:line`
  filter the selected projects are not chained, so only the tests at those lines run. `--project <name>` still runs that
  project's dependencies; add `--no-deps` to run it alone.
- In CI `retries` is 1 and the reporters are `github`, `list` and `html`; `forbidOnly` rejects a committed `test.only`.

**The setup wizard suite (`playwright.setup.config.ts`)** is a separate run because it needs a different world: a brand
new install. Its own port (`E2E_SETUP_PORT`, default 3105), its own database (`jobradar_e2e_setup_<port>`, dropped,
recreated and migrated without seed by `scripts/e2e-prepare.ts --fresh`), empty config and profile directories, and no
stand-in runner (requested cycles stay queued). One worker, specs in order, because they walk one install through the wizard.

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile`.

#### Cache Playwright browsers

`actions/cache` on `~/.cache/ms-playwright`, keyed on the runner OS and `pnpm-lock.yaml` (the browser build follows the
locked `@playwright/test` version). Sets `steps.playwright-cache.outputs.cache-hit`.

#### Install Playwright browser and system libraries

`pnpm exec playwright install --with-deps chromium`, only on a cache miss. Downloads Chromium and installs the operating
system libraries it needs (apt). Up to a minute.

#### Install Playwright system libraries

`pnpm exec playwright install-deps chromium`, only on a cache hit: the cache holds the browser, not the operating system
libraries, so those are installed on every run.

#### Cache the Next build cache

`actions/cache` on `.next/cache` (Next's incremental build cache only; the app is always built from the current source).
The key contains the lockfile and the hash of `src/`, `messages/`, `next.config.ts`, with the lockfile alone as the fallback.

#### Build

`pnpm build` (generates the i18n catalog, then `next build`). Produces the production build the server starts from. Up to 8
minutes allowed. A failure here is a compile or type error in the app that the `static` job did not
catch (for instance a server/client boundary violation).

#### End-to-end tests

`pnpm test:e2e --workers=2 --fail-on-flaky-tests`: all projects of the main suite as described above. The web server
command first runs `scripts/e2e-prepare.ts`, then `pnpm start -p 3100 -H 127.0.0.1`. A test that only passed on its retry
fails the job; the retry still records a trace for the report. Limit 12 minutes. Locally: start a disposable database (the
postgres container of the section below), `pnpm build`, then
`E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e`; `E2E_PORT=<port>` gives a run its own database and directories so several
checkouts can run side by side, but run **one full suite at a time per machine**: parallel full runs starve each other and
produce timeouts that are not real failures. While developing run only the affected specs
(`pnpm test:e2e e2e/pipeline.spec.ts`, several files, or `e2e/dashboard.spec.ts:206` for one test; only those run, the web
server and the stand-in runner start as usual); the full suite belongs to CI. Common failure causes: a locator that changed
with the UI text (the specs run in English), a spec that writes shared config but is missing from `SERIAL_CHAIN`, a test
that counts a whole list or changes shared rows without the `@exclusive` tag, a race that only shows up with two workers
(the trace shows it).

#### Setup wizard end-to-end tests

`pnpm test:e2e:setup --fail-on-flaky-tests`, after the main suite on the same build, in its own server, database and
directories (see above). Limit 6 minutes, typically 1 to 2. Report folder: `playwright-report-setup/`.

#### Upload the Playwright report and traces

Runs only when a step of the job failed (`if: failure()`): uploads `playwright-report/` (main suite),
`playwright-report-setup/` (setup wizard suite) and `test-results/` as the artifact `playwright-report`, kept 7 days.
Download it from the run page and open a report with `pnpm exec playwright show-report <folder>`.

### Job `linux-smoke`

The Linux first run from scratch: an empty checkout on the Ubuntu runner, `docker compose up --build` with the shipped
defaults, and the dashboard must answer. It catches what Docker Desktop on macOS hides: file ownership of the bind
mounts (`PUID` / `PGID`), config files written with mode 0600, folders the containers cannot write. Because it builds the
web, runner and jobspy images from the Dockerfiles, it is also what catches a broken `apt` / CLI install, a wrong `COPY`
path or a build-stage failure before a deploy does (there is no separate image-only build job). Runs for every pull
request that is not documentation-only, and for every push to `main`. Limit 20 minutes, the build step 15; typically a
few minutes (a cold build, without layer cache). Locally on a Linux machine: the commands of the steps below in a fresh clone (never in a checkout whose
stack and database you want to keep: the last step removes the stack and its volume).

#### Check out the repository

`actions/checkout`.

#### Prepare .env and the data folders as the host user

Writes a `.env` with only `PUID` / `PGID` set to the runner's own user (`id -u`, `id -g`), as
[host-setup.md](host-setup.md) tells Linux users to, and creates the `data/` folders and `.auth/` as that user, so the
bind mounts are not created by Docker as root.

#### Start the stack from scratch

`docker compose up -d --build --wait --wait-timeout 600`: builds the three images (web, runner, jobspy), pulls the
database image and waits until every service reports healthy (the runner applies the migrations and starts its
heartbeat). A failure here is a build error (the log shows the failing Dockerfile line; common causes: a package that
moved in the base image's repositories, a path added to `COPY` but excluded by `.dockerignore`, a changed lockfile that
no longer installs with `--frozen-lockfile` in the build stage) or a service that never became healthy: the "Container
logs on failure" step prints why.

#### Dashboard health check

`GET /api/health` must answer 200, and `GET /` (a page navigation) 200 or a redirect to the first-run wizard.

#### The web can write its config folder

Creates and removes a file in `data/config` inside the web container (the settings page and the wizard write there) and
checks that the runner can write `data/backups`. A failure means the container user does not own the bind-mounted
folders: check `user:` in `compose.yaml` and the `PUID` / `PGID` lines.

#### Container logs on failure

Only when an earlier step failed: `docker compose ps -a` and the last 200 log lines of every service.

#### Remove the stack and its volume

Always: `docker compose down -v --remove-orphans` on the throwaway runner.

### Job `ci-ok`

The single check to require. `needs` lists every other job and `if: always()` makes it run even when they fail or are
skipped. Limit 5 minutes, a few seconds.

#### All selected checks passed

Reads the `needs` results (`jq`): `changes`, `ci-docs`, `static` and `unit` must always have succeeded (a skipped one is a
failure, not a pass); `integration`, `e2e` and `linux-smoke` must have succeeded when `changes` selected code and be
skipped otherwise. Any other combination (including a job that must run and was skipped or cancelled) prints the per-job results and
`::error::a selected check did not succeed`. When it is red, look at the per-job lines it prints first, then open that job.

## Dependabot

`.github/dependabot.yml` opens weekly pull requests for three ecosystems:

| Ecosystem | Directory | Notes |
|---|---|---|
| `npm` | `/` | at most 5 open PRs; minor and patch updates grouped into one PR; major `@types/node` updates ignored (the types follow the Node major in `engines`) |
| `pip` | `/jobspy` | at most 3 open PRs; the sidecar's Python dependencies |
| `github-actions` | `/` | at most 3 open PRs; the action versions pinned in the workflows |

Dependabot PRs run the same pipeline as any other. An action bump changes `.github/`, so it counts as code and runs
everything; if it renames a step, `ci-docs` fails until this page is updated. This page names no action versions, so a
bump alone never needs a documentation change.

## Release check

`scripts/release-check.sh` is not part of the pipeline. A maintainer runs it by hand before the repository is published
or a release is cut ([RELEASING.md](../RELEASING.md)), and whenever a commit looks doubtful: gitleaks (through Docker) over
every file git would track and over the whole commit history (pinned image version), a scan for personal strings and
machine paths, a check that `.gitignore` covers `.env`, `data/` and `.auth/`, and a check that private planning ids
(`F-`, `B-` or `ADR-` and three digits, `M-` or `P-` and two digits, as used in the maintainer's tracker) appear in no file and no file name
(`ADR` in any case), except `drizzle/` and `pnpm-lock.yaml` at the repository root and the exact `path` or `path:line` entries in `scripts/planning-ids.allow` (an id that is data, not a reference). That one check
also runs alone as `scripts/release-check.sh --planning-ids-only` (no Docker, about a second): it is part of `scripts/validate.sh` and of
the unit test `tests/ops/release-check-script.test.ts`, so CI fails when an id comes back. Exit 0 is clean, 1 lists findings, 2 means it could not run. It is a separate gate because it needs
Docker for gitleaks and an untracked local patterns file that CI does not have.

## Running the whole pipeline locally

Every job above is a few commands. This is the generic recipe (Docker, Node 22 with pnpm, Python 3.12 are enough); it uses a
throwaway PostgreSQL on a port that is not your real database's.

```bash
# a throwaway database (the role may create databases, like the CI service). The database tests have no default
# address: without DATABASE_URL (E2E_ADMIN_DATABASE_URL also works for e2e) they stop and print this recipe, and they
# never connect to the database of your own installation.
docker run -d --name jr-ci-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:17
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres

pnpm install --frozen-lockfile

# jobs: changes (links) and ci-docs, static, unit  (the first block is what scripts/validate.sh does)
scripts/validate.sh            # shell syntax, i18n, lint, typecheck, unit tests, config, doc links, CI docs
pnpm build:runner
pnpm exec drizzle-kit generate < /dev/null && git status --porcelain -- drizzle   # must print nothing
(cd jobspy && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest -q)

# job: integration (needs pg_dump / pg_restore of major version 17, see the job's step)
export PG_DUMP_PATH=/path/to/pg_dump PG_RESTORE_PATH=/path/to/pg_restore REQUIRE_PG_TOOLS=1
pnpm test:integration --reporter=verbose
pnpm test:integration --sequence.shuffle.files --sequence.seed=$RANDOM

# job: e2e (one full suite at a time on this machine)
pnpm exec playwright install chromium
pnpm build
E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e --workers=2 --fail-on-flaky-tests
E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e:setup --fail-on-flaky-tests

# job: linux-smoke (Linux, in a fresh clone only: it ends with `docker compose down -v`; it builds the web, runner
# and jobspy images)
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" > .env && mkdir -p data/{config,profile,backups,exports,logs} .auth
docker compose up -d --build --wait --wait-timeout 600 && curl -fsS http://127.0.0.1:3000/api/health
docker compose down -v --remove-orphans

docker rm -f -v jr-ci-pg
```

A local run differs from the hosted one in three ways: it tests your working tree rather than the merge of the pull
request into `main`, it uses your Docker and Node versions, and it does not decide what to skip (for a documentation-only
change the hosted run does `pnpm docs:check`, `pnpm ci:docs-check`, the static checks and the unit tests).

## Keeping this page true

- Every job of a workflow needs a heading ``### Job `<job id>` `` (the key under `jobs:`; job ids are unique across
  workflows) and every step of it a heading `#### <step name>` below it, spelled exactly like the step's `name:`. Every
  step must have a `name:`; steps that only run an action (checkout, setup) have one too.
- Job and step headings are the only `###` / `####` headings used inside the "Jobs" part; put extra explanations under a
  step, under the job's introduction or in bold paragraphs.
- Mention every Dependabot ecosystem of `.github/dependabot.yml` in backticks in the "Dependabot" section.
- `docs/ci.zh.md` has the same job and step headings (kept in English because they are identifiers) with translated text.
- Run `pnpm ci:docs-check`; it prints which heading to add, rename or remove.
