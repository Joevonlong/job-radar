# Continuous integration explained

[English](ci.md) | [中文](ci.zh.md)

This page explains every job and step of the GitHub Actions pipeline (`.github/workflows/ci.yml`): what it does, which
tests it runs and why, how long it takes, how to run it on your own machine, and how to read a failure. It is written for
contributors and maintainers.

**This page is bound to the pipeline.** `pnpm ci:docs-check` (part of `scripts/validate.sh`, and the `ci-docs` job of the
pipeline itself) fails when a job or step of a workflow has no section here, when this page documents one that no longer
exists, or when [ci.zh.md](ci.zh.md) lists different jobs or steps. Change the pipeline, change this page (and its `.zh`
mirror) in the same pull request. The rules for the headings are at the end, under [Keeping this page true](#keeping-this-page-true).

Durations are typical values on the GitHub-hosted `ubuntu-24.04` runner (4 cores, 16 GB RAM); the run summary of each pull request
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
  changes -- code changed --> integration-shuffled["integration (shuffled)"]
  changes -- code changed --> worker-switch
  changes -- code changed --> e2e["e2e (parallel / chain)"]
  changes -- code changed --> linux-smoke
  changes -- deploy side or toolchain changed --> upgrade-transition["upgrade-transition (A / B)"]
  changes --> ci-ok
  ci-docs --> ci-ok
  static --> ci-ok
  unit --> ci-ok
  integration --> ci-ok
  integration-shuffled --> ci-ok
  worker-switch --> ci-ok
  e2e --> ci-ok
  linux-smoke --> ci-ok
  upgrade-transition --> ci-ok
  ci-ok --> merge([the one required check])
```

All jobs run side by side; the run takes as long as the slowest one rather than the sum. Worker-switch shards share
one runner; the default and shuffled integration passes and the two transition scenarios each have separate runners.
`ci-ok` is the single check a branch protection rule should require: it passes only when every job the classifier
selected succeeded.

Which jobs run depends on what the change touches (decided by the `changes` job):

| Change | Jobs that run |
|---|---|
| Pull request that changes only documentation (`*.md`, `*.html`, images; excludes toolchain paths and anything under `tests/`, `src/` or `public/`) | `changes` (with the documentation link check), `ci-docs`, `static`, `unit`, `ci-ok`. Several unit tests read the documentation (link targets, picture sizes), so they run. |
| Any other pull request (code, scripts, config, anything under `tests/`, `src/` or `public/`, workflows, Dockerfiles) | the above plus `integration`, `integration-shuffled` (`integration (shuffled)`), `worker-switch`, `e2e` and `linux-smoke` |
| Pull request that touches the deploy side (`scripts/ops/`, root `scripts/*.ts`, `src/lib/ops/`, `src/lib/config/migrations/`, `src/ai-worker/`, `compose.yaml`, `Dockerfile`, `tests/transition/`, `tests/ops/sim/`) | the above plus `upgrade-transition (A)` and `upgrade-transition (B)` |
| Dependency/toolchain pull request (`package.json`, lock/workspace files, `.github/**`, root test configs, Node version files) | everything (`full=true`, `transition=true`), including default-order integration |
| Push to `main` | always everything, whatever the pushed commits touch; `integration` also runs the default file order |
| Manual run (`workflow_dispatch`) | everything, like a push to `main` |

A job the classifier did not select (`integration`, `integration-shuffled`, `worker-switch`, `e2e`, `linux-smoke` on a documentation-only pull request) shows as
"skipped" and `ci-ok` accepts exactly that; a job that must run and was skipped, cancelled or failed makes `ci-ok` fail.

Workflow-level settings: `permissions: contents: read` (no job can write to the repository; pull requests from forks run
without secrets), a `concurrency` group per ref (a new push cancels the older run of a pull request, never a run on
`main`), and every job and step has a `timeout-minutes` so a hung step fails instead of sitting for hours.

## Reading a failed run

1. Open the pull request, look at the checks list: `ci-ok` is red whenever any job is red. The red job is the one to open.
2. In the job, the red step is expanded. Pull-request annotations (`::error::` lines, Playwright's `github` reporter) also
   appear on the "Files changed" tab and in the run summary.
3. For `e2e` the artifacts `playwright-report-parallel` and `playwright-report-chain` (kept 7 days) hold each failed
   part's HTML report and traces (`playwright-report/`). The parallel part also includes the setup wizard suite
   (`playwright-report-setup/`); open one with
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

Only a pull request is classified; it writes three outputs that the other jobs read:

- `code`: `true` unless every changed file is documentation (`*.md`, `*.html`, `png`, `jpg`, `svg`, `gif`). Anything
  under `tests/`, `src/` or `public/` is code even when it is an HTML file, an SVG or an image: the tests read their
  fixtures and the app ships its own pictures and pages. Scripts, YAML,
  Dockerfiles and workflows are code as well. `code` selects `integration`, `integration-shuffled`, `worker-switch`, `e2e` and `linux-smoke`; `static` and `unit`
  run either way (the unit tests read the documentation, and no list of "which tests read which file" is kept that
  could go stale). Toolchain paths take precedence over documentation extensions.
- `full`: `true` on pushes to `main`, manual runs and dependency/toolchain pull requests; it adds the default-order integration run. Toolchain paths are `package.json` (including `engines.node`), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, anything under `.github/`, root `vitest*.ts` / `playwright*.ts`, `.nvmrc` and `.node-version`. They also force `code=true` and `transition=true`, including Markdown under `.github/`.
- `transition`: `true` when a changed path starts with `scripts/ops/`, `src/lib/ops/`, `src/lib/config/migrations/`,
  `src/ai-worker/`, `tests/transition/` or `tests/ops/sim/`, is a TypeScript script directly under `scripts/`,
  is `compose.yaml` or `Dockerfile`, or touches the toolchain inputs above; it selects `upgrade-transition`.
  This includes the deploy's drain/freeze entry points and config migrations of existing installations. Changes only to
  `src/runner/`, `jobspy/` or `drizzle/` still use `linux-smoke` for startup coverage without selecting the transition suite.

A push to `main` and a manual run are not classified at all: they write `code=true`, `full=true` and `transition=true`. The commits on `main`
are what gets deployed, so a documentation-only push must not end in a run that checked nothing. The range of a pull
request is `base...head`, listed without rename detection, so a moved file counts with both its old and new path.
Paths are NUL-delimited (`git diff -z --name-only --no-renames`) and read individually from a temporary file, preserving
non-ASCII names (including Markdown under `.github/`) and embedded newlines. If the diff cannot be computed the step
fails (and so does `ci-ok`): there is no silent "nothing changed". `tests/ci-classifier.test.ts` extracts and executes
this script with CI's default `bash -e` shell, table-driven cases and a real temporary Git repository covering a rename,
deletion and non-ASCII path. Run it by hand: `git diff -z --name-only --no-renames origin/main...HEAD`, then inspect the
NUL-delimited records using the rules above.

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
Every job that uses the floating `22` sets `check-latest: true`: the runner's toolcache can lag a Node security release
behind `engines.node`, and the job would then run an older Node than the floor.

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

`for f in scripts/*.sh scripts/ops/*.sh scripts/ops/lib/*.sh tests/ops/*.sh tests/ops/proc-lib/*.sh; do bash -n "$f"; done`.
A parse-only check of the operations scripts (deploy, backup, restore, worker installers, validate), the libraries they
source and the shell test scripts. The scripts' behaviour is tested in `tests/ops/`. Instant.

#### Process library cases (bash 3.2)

`docker run --rm -v "$PWD":/w -w /w bash:3.2@sha256:0fd7cb8499c63a3c9345e7088a9cd83bb69f6e895e83833859aff838a0312091 bash tests/ops/proc-lib/cases.sh`.
`scripts/ops/lib/proc.sh` runs every state-changing command of the deploy scripts in its own process group, records
INT / TERM / HUP and finishes the current step before stopping, and maps exit codes. Its cases (new process group,
pipes and grandchildren under each signal, cooperative children, exit-code mapping, the two signal-versus-exit races run
60 times each, POSIX mode refused, `VAR=value proc_run`) run here under bash 3.2, the version of macOS `/bin/bash`. The
official `bash` images are pinned by digest; they are alpine with busybox, so `cases.sh` uses only `bash`, `sh`,
`uname`, `sleep` (with `0.05`), `cat`, `tr`, `grep`, `mktemp`, `rm`, `seq` and a readable `/proc`; it checks them
first and fails (never skips) with `FAIL: missing <tool>` when one is missing. The pseudo-terminal (`tostop`) cases and
the real-pnpm process-group case need `script`, `node` and `pnpm`, so they run in the unit job
(`tests/ops/proc-lib.test.ts`). About 30 seconds. Locally: the same command, or `bash tests/ops/proc-lib/cases.sh`.

#### Process library cases (bash 5.2)

`docker run --rm -v "$PWD":/w -w /w bash:5.2@sha256:a54fb4422b18f05dd3107c36f39d67b26334fda7ec89f4126052b45e228e2f15 bash tests/ops/proc-lib/cases.sh`.
The same cases under bash 5.2. The races matter most here: bash 5.2 returns 255 from a `wait` that a trap interrupted
just as the child ended, which `proc_run` avoids by polling with `kill -0` and waiting once. About 30 seconds.

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

`python -m pip install --require-hashes -r requirements-dev.txt` in `jobspy/`. Installs the sidecar's runtime and test
dependencies from the lock file: every package, indirect ones included, at a fixed version with its hashes, generated
from `requirements-dev.in` (the runtime versions are those of `requirements.txt`, which the image installs the same way;
see [development.md](development.md#the-jobspy-sidecars-dependencies)). A failure that names a hash or a missing
package means a lock file was edited by hand or not regenerated after an `.in` change.
Locally use a virtual environment: `python3.12 -m venv .venv && .venv/bin/pip install --require-hashes -r jobspy/requirements-dev.txt`.

#### Jobspy sidecar tests

`python -m pytest -q` in `jobspy/` (the tests in `jobspy/tests/`, with the scraping library mocked: request
validation, result mapping and error handling of the small HTTP service in `jobspy/app.py`). Two contract tests call the
real `scrape_jobs` through a proxy nothing listens on (no external request) to prove that upstream failures still arrive
in `frame.attrs["errors"]`, and one test checks that every `indeed:` country of
`config/packs/generic/geography.yaml` passes the sidecar's country validation. Seconds. Typical cause: a change to
`jobspy/app.py` without the matching test, or a dependency bump (a `python-jobspy` release that renames or drops
something).

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
database that is emptied before and after every file). The two worker switch files run in `worker-switch` instead.
Limit 45 minutes. This job keeps the default-order pass (only when `full=true`) and the lowest-Node release-module
checks. The shuffled pass runs concurrently in `integration-shuffled`, on its own runner and PostgreSQL service.

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

`pnpm test:integration --reporter=verbose`, only when `full` is true (pushes to `main`, manual runs, dependency/toolchain pull requests). The verbose
reporter prints each file as it starts, so a hung file is named. The two worker switch files are left out (`--exclude`):
they have their own job below. Limit 15 minutes. Run locally with a database as
described in [Running the whole pipeline locally](#running-the-whole-pipeline-locally).

#### Set up the lowest Node.js of engines.node

`actions/setup-node` again, now with Node 22.23.4, the lowest version `engines.node` (`>=22.23.4 <23`) allows. The host
ai-worker's release guard (`src/ai-worker/release-guard.mjs`) needs Node's synchronous module hooks, and tsx only uses
them from 22.22.3 on; 22.23.4 is the floor that carries the October 2026 Node security fixes. These are the last steps
of the job, so nothing after them runs with this Node.

#### Load a release module with the lowest Node.js

Builds a release directory of the checked-out commit with `scripts/ops/prepare-release.sh --offline` in a clone under a
temporary directory (the pnpm store already holds every package after the install step), then loads one of its `.ts`
modules through the release guard and the tsx loader from inside the release directory, as the ai-worker service will (tsx reads the path aliases from the release's `tsconfig.json`). Fails when that exits non-zero or
when stderr says `module.register called` (tsx would have taken the hooks-thread path, which the guard refuses). Limit 5
minutes. Locally, with Node 22.23.4 active: the same commands from the workflow, in a temporary directory, never with
`--root` pointing at your installation's checkout.

### Job `integration-shuffled`

The `integration (shuffled)` job runs on every code change, with the same `changes` gate, 45-minute limit,
PostgreSQL 17 service, environment, dependency setup and required client tools as `integration`. It has its own runner
and runs alongside the default-order and lowest-Node checks; no test selection or seed behavior changes.

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile`.

#### Provide PostgreSQL 17 client tools

Uses the same `scripts/ops/pg-docker.sh` symlinks and version checks as `integration` above, against this job's own
PostgreSQL 17 service. Limit 5 minutes; the client tools remain required, so backup tests cannot silently skip.

#### Integration tests (shuffled file order)

Runs the same suite with `--sequence.shuffle.files --sequence.seed=<seed>`; the seed is printed as a `::notice::`
annotation (`integration file order seed: N`). Other pull requests run only this order: it finds files that depend on
another file's leftovers, which a fixed order hides. To reproduce a failure, run
`pnpm test:integration --sequence.shuffle.files --sequence.seed=<seed>` with the seed from the annotation. The two worker
switch files are left out here too. Limit 15 minutes.

### Job `worker-switch`

Runs whenever `integration` runs: every code pull request, main push and manual run, with no additional path gate.
The install/switch and uninstall suites (`tests/integration/ai-worker-swap.test.ts` and
`tests/integration/uninstall-ai-worker.test.ts`) use real scripts against `tests/ops/sim` and a fake worker that takes
advisory locks and writes heartbeats. One job starts two independent Vitest processes, one per manager, instead of
running both managers sequentially. Job limit 45 minutes; the new wall time and resource use need measurement.

The PostgreSQL 17 service, `DATABASE_URL`, required pg client wrappers and dependency setup match `integration`.
Each process gets a unique global-setup database; the extra isolated databases and roles include PID/random suffixes.
Each fake installation uses its own `mkdtemp` directory, `HOME`, XDG directories and simulator state. These suites open
no listening ports, and advisory locks are scoped to their separate databases. Files remain sequential inside each
process (`fileParallelism: false`).

#### Check out the repository

`actions/checkout`.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile`.

#### Provide PostgreSQL 17 client tools

The same `pg_dump` / `pg_restore` symlinks to `scripts/ops/pg-docker.sh` and version checks as `integration`.

#### Start worker switch shards

Starts both processes in the background with `SWAP_MANAGERS=systemd` and `SWAP_MANAGERS=launchd`, the verbose reporter
and both test files. Each wrapper has its own process group, log, PID and atomically published exit-code file in a fresh
runner-temp directory. Limit 2 minutes. Prints `df -h` and `free -h` before launching; diagnostic failures are ignored.

`SWAP_MANAGERS` also accepts a comma-separated list (whitespace is trimmed and duplicates run once). Unset means both
managers, preserving local behavior. Empty or unknown entries throw during collection. The suite without a manager in
its title uses systemd and is registered only when systemd is selected, so it runs exactly once. No test-name filter is
used. Locally, with a disposable Postgres:

```bash
SWAP_MANAGERS=systemd pnpm test:integration --reporter=verbose tests/integration/ai-worker-swap.test.ts tests/integration/uninstall-ai-worker.test.ts
```

Change the value to `launchd`, or unset it for the original complete suite.

#### Worker switch (systemd)

Waits only for systemd's exit-code file. Limit 25 minutes, with a 24-minute deadline measured from launch. Missing
PID/status, a dead wrapper without status, deadline expiry, invalid status or a nonzero exit fails and prints the full
log; success prints the last 100 lines. Prints disk/free-memory snapshots at the start, every minute while waiting and
on exit; each diagnostic command is non-fatal and cannot change the shard's result. Runs after a previous failure
unless the run was cancelled, so one failed shard does not hide the other.

#### Worker switch (launchd)

The same independent wait and 25-minute limit for launchd, using the same launch-time deadline. It can finish and
report success even when systemd fails; it never treats systemd's exit-code file as its own result.

#### Clean up worker switch shards

Always runs, with a 5-minute step limit. The launcher, waits and cleanup atomically create a per-shard `.term-sent`
marker directory before sending TERM, so each recorded group receives it at most once. Cleanup sends TERM only to
groups without that marker and only waits for already-signalled groups. It allows up to 90 seconds in total from
cleanup start before sending KILL to remaining groups, and ignores further cancellation signals during this grace
period. The wrappers wait for their children to finish before writing status. Actions' initial INT is translated to
TERM because background bash children can ignore INT.

### Job `e2e`

The Playwright browser suite against a production build (`pnpm build` then `pnpm start`), a throwaway PostgreSQL 17 service
and a stand-in runner (`scripts/e2e-runner.ts`: heartbeat, config acknowledgement and control-request polling, so
"run a cycle now" and "config saved" work without a real collector). No AI provider, no job channel and no network
beyond localhost. The specs under `e2e/` plus the ones in `e2e-setup/`. Two matrix jobs, `e2e (parallel)` and
`e2e (chain)`, run side by side with `fail-fast: false`, so a failure in one does not cancel the other. Each has its own
runner, production build, PostgreSQL service, seeded database, config and profile directories, and a 25-minute limit.
Both run on the runner host, not in the Playwright container image (measured: the image was slower).

The test steps set `E2E_PART` from the matrix:

- `parallel`: `chromium` followed by `chromium-exclusive`, then the setup wizard with `playwright.setup.config.ts`.
  The setup wizard step runs only when `matrix.part == 'parallel'`.
- `chain`: only the `SERIAL_CHAIN` projects in `e2e/projects.ts`. The first project has no dependency on
  `chromium-exclusive`; each later project still depends on the previous one. The separate database and directories
  let this chain run alongside the parallel part safely.

With `E2E_PART` unset, local runs keep the full sequence: parallel, exclusive, then the chain. Any value other than
`parallel` or `chain` is an error. With a disposable database configured, reproduce a part with
`E2E_PART=chain pnpm test:e2e` or `E2E_PART=parallel pnpm test:e2e`; the latter command runs the main-suite part only,
so also run `pnpm test:e2e:setup` to reproduce that CI job's setup wizard coverage.

What the environment looks like: `DATABASE_URL` points at the service (a local run must set `DATABASE_URL` or
`E2E_ADMIN_DATABASE_URL` itself: there is no default address); `scripts/e2e-prepare.ts`, which refuses any database whose
name does not start with `jobradar_e2e`, creates the database
`jobradar_e2e_3100` (the name follows `E2E_PORT`), applies the migrations and loads the dashboard seed (fictional postings), and fills a fresh
config and profile directory from the frozen fixture in `tests/fixtures/config/defaults/`. `E2E_PORT=3100` is the server
port; `E2E_SKIP_BUILD=1` tells the web server command not to build again.

**Projects of the main suite (`playwright.config.ts`).** The specs do not all run the same way:

The projects are planned in `e2e/projects.ts` (unit-tested by `tests/e2e-projects.test.ts`, which also checks with
`playwright test --list` that a named spec runs alone).

- `chromium` runs most specs fully in parallel (2 workers on the 4-core runner), each in its own browser context. It
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
  after another. In full mode they start only after `chromium-exclusive` has finished; in the `chain` part the first
  project starts immediately. First the config chain: `chromium-config-settings`,
  `-settings-invalid`, `-language`, `-breakdown`, `-resume`. Then the interests chain: `chromium-interests`,
  `chromium-interests-suggestions`, `chromium-multi-filters` and `chromium-companies` (save views, accepted suggestions or
  watched companies to the one `interests.yaml`). Then `chromium-sources-registry` and `chromium-sources-discovery` (both rewrite `sources.yaml`), then
  `chromium-settings-advanced` and `chromium-settings-workflow` (the advanced editor and the workflow tab rewrite ui, notify,
  ai, sources and pipeline config), then `chromium-deal-breakers` (rewrites `deal_breakers` in `preferences.yaml` and one
  job's filter result), then `chromium-visa` (rewrites `needs_visa_sponsorship` in `me.yaml`), and last `chromium-market` (switching the market changes every page and
  `preferences.yaml`). The chain is the reason the total is not `slowest spec / 2`: it is serial by design.
- A new spec that writes any file of the config directory must be added to `SERIAL_CHAIN` in `e2e/projects.ts` (its
  own chained project); otherwise it will fail randomly in parallel with other specs. A new test that changes shared
  database state or counts whole lists gets `{ tag: EXCLUSIVE_TAG }`.
- Every spec imports `test` and `expect` from `e2e/fixtures.ts`, not from `@playwright/test` (`pnpm lint` fails
  otherwise; type-only imports are fine). Its pages never leave while a Server Action is still in flight:
  `goto`, `reload`, `goBack`, `goForward`, `close`, `context.close()` and the end of each test first wait until every
  action request the context's pages started has its whole answer (up to 15 s, then the call fails naming the action).
  Without it a reload right after an optimistic update cancels the save and the page after the reload contradicts the
  one before. Before reading stored state some other way (the database, a config file), call `waitForServerActions(page)`
  or poll. `E2E_SERVER_ACTION_DELAY_MS=<ms>` holds every action request that long, which exposes navigation paths the
  guard does not cover and direct reads of stored state (the database) that skip the wait, and makes them fail every
  time; it does not catch a spec that bypasses the fixture import (the lint rule covers imports, dynamic ones and
  `playwright` / `playwright-core` included). `e2e/server-action-guard.spec.ts` tests the guard itself.
  Not covered: full-document navigations the page starts itself (a link click, a form submit), `page.setContent()`,
  `browser.close()`, and contexts from `browser.newContext()` that the test never closes (only the `context` fixture
  gets the end-of-test wait). The guard sees an action from its `fetch` call on; the moment before that is short but not
  covered, which is why a quiet period of 400 ms must follow the last settled action.
- Spec files named on the command line (`pnpm test:e2e e2e/settings.spec.ts`) run alone: only the projects with a
  matching spec take part, each narrowed to the named specs and still in the order above. (Playwright runs a dependency
  project in full, so without this a chained spec would first run the whole parallel suite.) With a `file:line`
  filter the selected projects are not chained, so only the tests at those lines run. With `E2E_PART`, both kinds of
  filter stay within that part. `--project <name>` still runs that project's dependencies. Use `E2E_PART=chain` to run
  the chain; `--no-deps` would remove its serial ordering.
- In CI `retries` is 1 and the reporters are `github`, `list` and `html`; `forbidOnly` rejects a committed `test.only`.

**The setup wizard suite (`playwright.setup.config.ts`)** is a separate run because it needs a different world: a brand
new install. Its own port (`E2E_SETUP_PORT`, default 3105), its own database (`jobradar_e2e_setup_<port>`, dropped,
recreated and migrated without seed by `scripts/e2e-prepare.ts --fresh`), empty config and profile directories, and no
stand-in runner (requested cycles stay queued). Unlike the main suite it does not use the frozen fixture: its defaults
directory is the shipped `config/` (with its example profile), exactly what a first `docker compose up` starts from,
so it is a product-contract test and fails when a change to the shipped defaults breaks the first-run experience. One
worker, specs in order, because they walk one install through the wizard.

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

#### Install Playwright browser

`pnpm exec playwright install chromium`, only on a cache miss. Downloads Chromium without installing system libraries.
Limit 8 minutes.

#### Playwright system libraries (installed only when the browser cannot start)

On both cache hits and misses, a Node check uses `@playwright/test` to launch Chromium headless and close it (10-second
launch timeout, 20-second total limit per check). A failure prints the error and runs `pnpm exec playwright install-deps
chromium`, then repeats the check; a failed install or retry fails the step. The step retains its 8-minute limit.

The Ubuntu runner generally already provides Chrome's shared libraries. Checking first avoids unnecessary apt calls,
whose long-tail latency and occasional timeouts have failed otherwise healthy runs.

#### Cache the Next build cache

`actions/cache` on `.next/cache` (Next's incremental build cache only; the app is always built from the current source).
The key contains the lockfile and the hash of `src/`, `messages/`, `next.config.ts`, with the lockfile alone as the fallback.

#### Build

`pnpm build` (generates the i18n catalog, then `next build`). Produces the production build the server starts from. Up to 8
minutes allowed. A failure here is a compile or type error in the app that the `static` job did not
catch (for instance a server/client boundary violation).

#### End-to-end tests

`pnpm test:e2e --workers=2 --fail-on-flaky-tests`, with `E2E_PART=${{ matrix.part }}`: that part's main-suite projects
as described above. The web server
command first runs `scripts/e2e-prepare.ts`, then `pnpm start -p 3100 -H 127.0.0.1`. A test that only passed on its retry
fails the job; the retry still records a trace for the report. Limit 15 minutes. Locally: start a disposable database (the
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

`pnpm test:e2e:setup --fail-on-flaky-tests`, only in the `parallel` part (`if: matrix.part == 'parallel'`), after its
main-suite projects on the same build, in its own server, database and directories (see above). Limit 6 minutes,
typically 1 to 2. Report folder: `playwright-report-setup/`.

#### Upload the Playwright report and traces

Runs only when a step of the matrix job failed (`if: failure()`): uploads `playwright-report/` (that part's main-suite
projects), `playwright-report-setup/` (setup wizard, present only in the parallel part) and `test-results/` as the artifact
`playwright-report-${{ matrix.part }}` (`playwright-report-parallel` or `playwright-report-chain`), kept 7 days.
Download it from the run page and open a report with `pnpm exec playwright show-report <folder>`.

### Job `linux-smoke`

The Linux first run from scratch: an empty checkout on the Ubuntu runner, `docker compose up --build` with the shipped
defaults, and the dashboard must answer. It catches what Docker Desktop on macOS hides: file ownership of the bind
mounts (`PUID` / `PGID`), config files written with mode 0600, folders the containers cannot write. Because it builds the
web, runner and jobspy images from the Dockerfiles, it is also what catches a broken `apt` / CLI install, a wrong `COPY`
path or a build-stage failure before a deploy does (there is no separate image-only build job). The Dockerfile compiles the
web and the runner with `RUN --network=none` (from a build stage without any `.next` cache), so this build also proves
that compiling needs no network: the fonts come from the npm packages, and a lookup on the internet at build time fails
the job. It builds the images
the way `scripts/ops/deploy.sh` does, from an unpacked `git archive` of the commit, and checks the shipped config in
them (the `config/` files are part of the images, not mounted), and that a build from a working tree leaves out
everything `.gitignore` ignores. Runs for every pull
request that is not documentation-only, and for every push to `main`. Limit 20 minutes, the build step 15; typically a
few minutes (a cold build, without layer cache). Locally on a Linux machine: the commands of the steps below in a fresh clone (never in a checkout whose
stack and database you want to keep: the last step removes the stack and its volume).

#### Check out the repository

`actions/checkout`.

#### Prepare .env and the data folders as the host user

Writes a `.env` with only `PUID` / `PGID` set to the runner's own user (`id -u`, `id -g`), as
[host-setup.md](host-setup.md) tells Linux users to, and creates the `data/` folders and `.auth/` as that user, so the
bind mounts are not created by Docker as root.

#### Unpack the commit as the build context

`git archive HEAD | tar -x -C "$(mktemp -d)"`, and that directory goes into `JOB_RADAR_BUILD_CONTEXT` for the following
steps. `compose.yaml` builds web, runner and jobspy from `${JOB_RADAR_BUILD_CONTEXT:-.}`, which `scripts/ops/deploy.sh`
sets the same way, so the images contain only committed files. Instant.

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

#### The images ship exactly the committed config

Lists the files under `/app/config` in the web and runner containers and compares them with `git ls-files config`
(`diff -u`). A difference means the Dockerfile's `COPY config/ /app/config/` or `.dockerignore` changed what reaches the
image. Seconds.

#### The shipped config is read-only for every user

Four `find`s in each container, run as the container's own user, must print nothing: `find /app/config ! -user root`
(everything owned by root), `find /app/config -perm /022` (nothing writable by group or others), `find /app/config -type
f ! -perm -444` (every file readable by all) and `find /app/config -type d ! -perm -555` (every directory readable and
searchable by all). A failure means the `RUN chmod -R a+rX,go-w /app/config` in the Dockerfile is missing or runs before
a later `COPY`. Seconds.

#### Nothing is mounted over the shipped config

`docker inspect` of the web and runner containers: no mount may have `/app/config` (or a path below it) as its
destination. A mount there would hide the config in the image; the doctor (`config.shipped`) warns about it on an
installation too. Instant.

#### Docker build context leaves out what .gitignore ignores

`bash tests/ops/gitignore-coverage.sh`. In a temporary directory with copies of `.gitignore` and `.dockerignore`, it
turns every `.gitignore` entry into a sample file at the root and one in a subdirectory (the expansion rule is in the
script's header; `git check-ignore` confirms that git ignores each sample), lists two build contexts with
`tests/fixtures/docker/context-list.Dockerfile` (`node:${{NODE_VERSION}}-slim`, `NODE_VERSION` from the Dockerfile, checked in the
build log) and fails when any sample is in a context. Negations (`!.env.example`, the `data/` markers) are in an
allowlist with their reasons. A failure names the leaked samples: add the entry to `.dockerignore`, at any depth
(`**/`) when `.gitignore` matches it at any depth. Deploys build from `git archive` and never see ignored files; this
covers `pnpm stack:up` and a plain `docker compose build`. About 10 seconds.

#### The runner restarts healthy with the sidecar stopped

`docker compose stop jobspy`, `docker compose restart runner`, then `docker compose up -d --no-recreate --wait
--wait-timeout 180 runner`: the runner must turn healthy again while the sidecar is down, and starting it must not start
the sidecar (it is not among the running services afterwards). Every channel that uses the sidecar is off by default, so
the runner does not depend on it in `compose.yaml`, and `scripts/ops/deploy.sh` starts it on its own; a failure means
that dependency came back. About a minute (the runner's healthcheck interval).

#### Container logs on failure

Only when an earlier step failed: `docker compose ps -a` and the last 200 log lines of every service.

#### Remove the stack and its volume

Always: `docker compose down -v --remove-orphans` on the throwaway runner.

### Job `upgrade-transition`

Upgrade transitions with real Docker and the real deploy, install and uninstall scripts of each version, the ai-worker
under the systemd simulator (`tests/transition/run.sh`). Runs when `changes` sets `transition` (pull requests that touch
the deploy side or toolchain, every push to `main`, manual runs). The matrix creates `upgrade-transition (A)` and
`upgrade-transition (B)` on separate runners with `fail-fast: false`: one failure does not cancel the other.
No service container: each compose project of the script runs its own database. Each leg keeps the 120-minute job limit,
65-minute launch-time deadline and 66-minute wait cap. Setup and launch caps total 25 minutes; allowing 1 minute for
reporting, 5 minutes for cleanup (including its 240-second grace), and one 5-minute upload gives a conservative
101-minute budget per leg, leaving 19 minutes before the job limit.

#### Check out the repository

`actions/checkout` with `fetch-depth: 0`: the scenarios check out the earlier versions.

#### Set up pnpm

`pnpm/action-setup`.

#### Set up Node.js

`actions/setup-node`, Node 22, pnpm store cache.

#### Install dependencies

`pnpm install --frozen-lockfile` (fills the pnpm store the release directories install from).

#### Start transition scenarios

Starts only the matrix-selected scenario in the background: `bash tests/transition/run.sh --scenarios A <artifacts-A>`
or `--scenarios B <artifacts-B>`, using `SCENARIO` from `matrix.scenario`. Limit 2 minutes. Each leg has its own runner,
Docker daemon and layer cache, runner-temp artifacts, random `RUN_ID`, temporary root, compose-project prefix,
HOME/XDG directories and simulator state. Images have project-specific names and deploys use `--no-prune`.

Prints `df -h`, `free -h` and `docker system df` before launch. Each selected wait prints them at its start, every
minute while waiting and on exit. Every diagnostic command is non-fatal and cannot change a scenario's result.
Measure the wall-clock gain on hosted runs: A and B previously competed for resources on one runner.

#### Transition scenario A

Runs only in `upgrade-transition (A)` (`matrix.scenario == 'A'`), with the exact step name `Transition scenario A`.
Waits only for A's atomically published exit-code file; limit 66 minutes, with a 65-minute deadline from launch.
Missing status, a dead wrapper without status, deadline expiry or a nonzero/invalid status fails with the full log;
success prints its last 100 lines. Waits run even after a previous failure, unless cancelled.
In clones with isolated compose projects (`jrtransition-<random>-*`), ports, volumes and passwords, scheduled cycles off:

- A: 62d7ad9, then each documented hop (4dd8d03, 2656364, b3f69b0, the checked-out commit) with that version's
  `deploy.sh --skip-pull`, the stop of web and runner before 2656364, and the first-upgrade steps of `docs/upgrade.md`
  (uninstall the old worker, check that it stopped, stop web and runner, check out, deploy) before the last one.

#### Transition scenario B

Runs only in `upgrade-transition (B)` (`matrix.scenario == 'B'`), with the exact step name `Transition scenario B`.
The same independent wait and 66-minute limit for B, measured from its own launch. B builds its own starting
version and keeps D, C and E inside its process because they depend on its state:

- B: 62d7ad9; the new `install-ai-worker.sh --release` of a release whose worker throws at start must roll back to the
  worker installed from the checkout; the same with a good release succeeds; then the strict stop and the deploy of the
  checked-out commit.
- D: a deploy whose runner image fails to build (the build arg `FAIL_RUNNER_BUILD=1`) changes no container, image or
  worker and leaves no lock; the same deploy without it succeeds.
- C: a release with a broken tsx loader is rolled back.
- E: the emergency restore of the previous release; the doctor reports release != HEAD. Then the uninstall.

After each step: `/app/config` of the web and runner containers equals `config/` of the deployed commit (sha256 of every
file); the worker's MainPID runs from the expected directory and `install-ai-worker.sh --print-release` agrees; a
`run_ai` request is done by the worker; the doctor's JSON (`--only config.shipped --only ops`) has the shipped config
check, and from the release-directory version on confirms the reports and finds no lock and no switch backup. Safety: before
anything runs, the caller's compose, docker and database variables (`COMPOSE_*`, `DOCKER_HOST`, `JOBRADAR_*`,
`JOB_RADAR_*`, `POSTGRES_*`, `PG*`, `DATABASE_URL` and every name the compose files interpolate) are unset, so none of
them can override a project's `.env` (`tests/transition/clean-env.sh`). A docker guard (`tests/transition/docker-guard.sh`)
lets through read-only commands; a compose command that changes something runs only for the script's own projects, and
only after `docker compose config` of that same command passed `tests/transition/compose-check.mjs` (every volume
named with the run's prefix and not external, every bind mount and build context inside the run's directory, no
`container_name`, only the ports registered for the project); `down`, prune and `volume rm` are refused. Cleanup checks
the configuration and the containers' mounts the same way, runs `down` without `-v` and removes only volumes named with
the project's prefix. `launchctl` and `systemctl` must resolve to the simulator. `tests/ops/transition-guard.test.ts`
covers these rails with fake docker binaries. These checks apply to both scenarios. Locally (Linux or macOS, Docker
with compose v2), run each command with a distinct artifact directory; the temporary directory and the script's compose projects, images and volumes are removed at the end.

Not covered: launchd (the integration tests run the switch against the launchd simulator; real launchd is the manual
drill), and `deploy.sh`'s own git pull (each hop checks out the commit and uses `--skip-pull`). Off Linux the doctor's
match of the worker's report against systemd is skipped.

#### Clean up transition scenarios

Always runs, limit 5 minutes. The launcher, waits and cleanup atomically create a per-shard `.term-sent` marker
directory before forwarding TERM. Cleanup signals only groups without a marker and only waits for already-signalled
groups: it never sends a second TERM while `run.sh` has reset traps to default during artifact collection and guarded
compose teardown. It allows up to 240 seconds in total from cleanup start before sending KILL to any remaining group,
and ignores further cancellation signals during the grace period. The wrappers publish status only after their
children finish cleanup.

#### Upload the transition logs (scenario A)

Only in the A leg when an earlier step failed and launch published its state directory
(`failure() && matrix.scenario == 'A' && env.TRANSITION_STATE != ''`):
A's wrapper log and artifact directory (worker logs, simulator calls and per-step output), as `upgrade-transition-logs-A`,
kept 7 days. Success or cancellation alone does not trigger an upload.

#### Upload the transition logs (scenario B)

Only in the B leg (`failure() && matrix.scenario == 'B' && env.TRANSITION_STATE != ''`),
as `upgrade-transition-logs-B`, from its separate wrapper log and artifact
directory, kept 7 days.

### Job `ci-ok`

The single check to require. `needs` lists every other job and `if: always()` makes it run even when they fail or are
skipped. Limit 5 minutes, a few seconds.

#### All selected checks passed

Reads the `needs` results (`jq`): `changes`, `ci-docs`, `static` and `unit` must always have succeeded (a skipped one is a
failure, not a pass); `integration`, `integration-shuffled`, `worker-switch`, `e2e` and `linux-smoke` must have succeeded
when `changes` selected code and be skipped otherwise; `upgrade-transition` likewise with `transition`. `needs["upgrade-transition"].result` aggregates its
matrix: both legs must succeed when selected, and the entire matrix must be skipped otherwise. `needs.e2e.result`
aggregates both e2e matrix jobs, so both parts must succeed on code changes; the entire matrix must be skipped on documentation-only changes. Any other
combination (including a job that must run and was skipped or cancelled) prints the per-job results and
`::error::a selected check did not succeed`. When it is red, look at the per-job lines it prints first, then open that job.

## Dependabot

`.github/dependabot.yml` opens weekly pull requests for four ecosystems:

| Ecosystem | Directory | Notes |
|---|---|---|
| `npm` | `/` | at most 5 open PRs; the font packages (`@fontsource/*`, `@fontsource-variable/*`) in a PR of their own (a font update changes how every page looks: compare the pages before merging), other minor and patch updates grouped into one PR; major `@types/node` updates ignored (the types follow the Node major in `engines`) |
| `pip` | `/jobspy` | at most 3 open PRs; the sidecar's Python dependencies, in the pip-compile layout: a PR changes a pin in `requirements*.in` and regenerates the hashed lock files `requirements*.txt` |
| `docker` | `/jobspy` | at most 2 open PRs; the digest of the base image in `jobspy/Dockerfile` (the root `Dockerfile` takes its image tags from build arguments, which Dependabot cannot update) |
| `github-actions` | `/` | at most 3 open PRs; the action versions pinned in the workflows |

Dependabot PRs run the same pipeline as any other. An action bump changes `.github/`, so it selects full coverage and runs
everything; if it renames a step, `ci-docs` fails until this page is updated. This page names no action versions, so a
bump alone never needs a documentation change.

Every `uses:` in the workflows is pinned to a full 40-character commit SHA, with the release tag as a trailing comment
(`uses: actions/checkout@<sha> # vX.Y.Z`), because a tag can be moved to different code. Dependabot's `github-actions`
ecosystem understands this form and updates the SHA and the comment together. When adding an action, resolve the tag to
its commit (dereference annotated tags) and pin that.

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
bash tests/ops/proc-lib/cases.sh   # the CI also runs it in the pinned bash:3.2 and bash:5.2 images (see the job)
pnpm exec drizzle-kit generate < /dev/null && git status --porcelain -- drizzle   # must print nothing
(cd jobspy && python3.12 -m venv .venv && .venv/bin/pip install --require-hashes -r requirements-dev.txt && .venv/bin/python -m pytest -q)

# jobs: integration and integration-shuffled (separate CI runners; run locally in sequence; pg tools major 17)
export PG_DUMP_PATH=/path/to/pg_dump PG_RESTORE_PATH=/path/to/pg_restore REQUIRE_PG_TOOLS=1
pnpm test:integration --reporter=verbose --exclude "tests/integration/ai-worker-swap.test.ts" --exclude "tests/integration/uninstall-ai-worker.test.ts"
pnpm test:integration --sequence.shuffle.files --sequence.seed=$RANDOM --exclude "tests/integration/ai-worker-swap.test.ts" --exclude "tests/integration/uninstall-ai-worker.test.ts"

# job: worker-switch (CI starts these as two background processes; run serially here)
SWAP_MANAGERS=systemd pnpm test:integration --reporter=verbose tests/integration/ai-worker-swap.test.ts tests/integration/uninstall-ai-worker.test.ts
SWAP_MANAGERS=launchd pnpm test:integration --reporter=verbose tests/integration/ai-worker-swap.test.ts tests/integration/uninstall-ai-worker.test.ts

# job: e2e (CI uses separate runners; reproduce the parts serially on this machine)
pnpm exec playwright install chromium
pnpm build
E2E_PART=parallel E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e --workers=2 --fail-on-flaky-tests
E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e:setup --fail-on-flaky-tests
E2E_PART=chain E2E_PORT=3100 E2E_SKIP_BUILD=1 pnpm test:e2e --workers=2 --fail-on-flaky-tests

# job: linux-smoke (Linux, in a fresh clone only: it ends with `docker compose down -v`; it builds the web, runner
# and jobspy images)
printf 'PUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" > .env && mkdir -p data/{config,profile,backups,exports,logs} .auth
export JOB_RADAR_BUILD_CONTEXT="$(mktemp -d)" && git archive HEAD | tar -x -C "$JOB_RADAR_BUILD_CONTEXT"
docker compose up -d --build --wait --wait-timeout 600 && curl -fsS http://127.0.0.1:3000/api/health
bash tests/ops/gitignore-coverage.sh
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
