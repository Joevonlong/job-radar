# Changelog

All notable changes to Job Radar are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Upgrade notes

- **The shipped config is now part of the images.** Upgrading from 2.0.1 or older with `scripts/ops/deploy.sh` yourself
  takes three commands once: `docker compose -p job-radar stop web runner`, then `git pull` (or `git fetch --tags && git
  checkout --detach <tag>`), then `scripts/ops/deploy.sh --skip-pull`. A plain `docker compose up -d` is not enough. Why,
  and the details: [docs/upgrade.md](docs/upgrade.md) ("Upgrading across the shipped config in the images"). A
  `compose.override.yaml` of your own that mounts `./config` must drop that mount (`pnpm run doctor` warns about it).
- **`scripts/ops/deploy.sh` refuses a checkout with uncommitted changes to tracked files in every mode**, `--skip-pull`
  included (untracked files are fine). Commit or stash first.
- **The host ai-worker runs from a release directory.** The first upgrade to this version stops the worker until the
  deploy installs it again: run `scripts/ops/uninstall-ai-worker.sh`, check that it stopped, `docker compose -p
  job-radar stop web runner`, update the code, then `scripts/ops/deploy.sh --skip-pull`. A custom
  `doctor.ai_worker_launchd_label` needs a manual `launchctl bootout` first. See
  [docs/upgrade.md](docs/upgrade.md#first-upgrade-release-dir). `deploy.sh --ref` refuses older versions; going back
  takes the manual steps in [docs/upgrade.md](docs/upgrade.md#downgrade-pre-release-dir).
- **Deploy steps renumbered** (12 steps): release is step 7, up step 8, migrate step 9, ai-worker step 10, and the
  Docker cleanup (prune) step 11, after the ai-worker switch. `--no-prune` skips step 11, `--no-ai-worker` steps 7
  and 10.
- **Install the database before the ai-worker:** `scripts/ops/install-ai-worker.sh` now waits for the new worker to hold
  its database lock and write a heartbeat, so on a new host run `docker compose up -d` (at least the db) first.
- **Node.js 22.23.4 or a later 22.x is required** (`engines.node` is now `>=22.23.4 <23`), and pnpm must be the version
  in `package.json` (`packageManager`; `corepack enable` provides it). The Docker build stages check the Node version
  of their image.
- **Salary config migration (1 → 2):** `salary.yaml` no longer accepts `benchmark.include_ai_lookups`.
  `scripts/ops/deploy.sh` migrates it automatically; for a manual upgrade, run `pnpm config:migrate` to see what the step
  removes, then `pnpm config:migrate --write`. A v2 file with this key fails validation as an unknown key.
- **Salary card during deploy:** step 4 migrates the config before the backup, build and restart. The old web may show
  a salary configuration error for a few minutes until the new code restarts; the runner keeps its last valid settings.
  If the build fails, the error persists: fix the build and rerun `scripts/ops/deploy.sh` (preferred), or stay on the old
  version and set `salary.yaml`'s `config_version` back to the old code's current version. This is safe because the
  migration already removed the key. If instead you restore the original from `.backup/`, follow rollback (b) below.
- **Existing salary comparisons containing AI figures are hidden** until the next successful recomputation. With the
  benchmark on, the card shows "not computed yet" until then; run `pnpm salary:benchmark` to recompute now. With the
  benchmark off, it keeps showing "The old salary comparison contained AI figures and is hidden" until you turn it
  on and wait for a cycle or recompute manually; the command does not recompute while it is off. Installations whose
  comparisons contained no AI figures are unaffected. Users who had AI lookups enabled in the benchmark lose the AI
  part of the sample count.

**Salary lookup rollback for this release.** Older code does not hide comparisons containing AI figures.

- **(a) Preferred: recompute with the new code before switching.** If the benchmark is off, temporarily set
  `benchmark.enabled: true` in `salary.yaml`, run `pnpm salary:benchmark`, confirm that it prints a summary and exits
  with code 0, then restore the previous setting.
- **(b) Configuration (required):** Whether you set `salary.yaml`'s `config_version` back to the old code's current
  version or restore the original from `data/config/.backup/<timestamp>/`, confirm that `benchmark.include_ai_lookups`
  is absent or `false` **before the old code starts**. The backup may contain `true`. Otherwise, the old code can count
  older cached lookups again (where the latest cached result still predates the upgrade); upgrading again hides the
  comparison until it is recomputed.
- **(c) If you restore a database backup, or (a) did not succeed:** The `pre-deploy` backup contains the old benchmark
  table, so restoring it undoes (a). With the old code running and `benchmark.include_ai_lookups` absent or `false`,
  run `pnpm salary:benchmark` again (if the benchmark is off, temporarily enable it, recompute, then restore the
  previous setting). Until this recomputation, the old code may display comparisons containing AI figures.

A failure in (a) does not block rollback: follow (c) and accept the display window before that recomputation.

### Changed

- **AI salary lookups are only displayed:** they never count in the salary benchmark or any filter; the benchmark uses
  only salaries stated in postings. The Salary tab's switch to count AI lookups is removed and the benchmark card shows
  only "sample n". Lookup cards label the company level and every band "AI estimate (unverified)", identify "AI's own
  confidence" and "Sources given by the AI (unverified)", and explain that similar postings share a lookup that is not
  based on this job description. A lookup made on another posting links to it, or says that posting was deleted.
- **Images built from the commit being deployed:** `scripts/ops/deploy.sh` unpacks a `git archive` of the commit it
  deploys into `data/build/` and builds from there (`JOB_RADAR_BUILD_CONTEXT`), so ignored, untracked or locally
  changed files never reach an image. The web and runner images carry the shipped defaults in `/app/config` (owned by
  root, read-only for everyone); `compose.yaml` no longer mounts `./config`. Every later step checks that the checkout
  still is at that commit and stops with `checkout moved during deploy` otherwise; a `git status` that fails (a damaged
  index) stops the deploy too instead of passing as clean. See
  [docs/deploy.md](docs/deploy.md#build-context-and-a-clean-checkout).
- **One deploy at a time:** `scripts/ops/deploy.sh` takes a lock (`data/releases/ai-worker/.lock/`); a second deploy stops
  in step 1 and prints who holds the lock and how to check and clear one that was left behind.
- **Interrupting a deploy** (Ctrl-C, closing the terminal, `kill`) lets the running step finish, starts no further step,
  releases the lock and exits with 130, 143 or 129; the script prints how to abort the running step at once.
  See [docs/deploy.md](docs/deploy.md#interrupting-a-deploy).
- **The ai-worker runs from `data/releases/ai-worker/<commit>/`**, a read-only copy of the deployed commit with its
  production dependencies (built by `scripts/ops/prepare-release.sh`, step 7 of the deploy), so a `git pull` no longer
  changes the code of the running worker. `scripts/ops/install-ai-worker.sh --release <dir>` replaces the running
  worker only after the new one holds its instance lock and wrote a heartbeat, and otherwise puts the previous
  definition back and waits for it (`not changed:`, `rolled back:` or `ROLLBACK FAILED:` say what happened; a
  signal during the switch rolls back first). The definition names only absolute paths and sets `NODE_OPTIONS` empty.
  `--print-release` prints the installed release (exit 3 when none, 4 when not from a release directory). The
  previous releases are kept for a worker-only rollback. `scripts/ops/uninstall-ai-worker.sh` uses the same identity
  rules, so a worker under a custom label is removed too. See
  [docs/deploy.md](docs/deploy.md#the-ai-worker-runs-from-a-release-directory).
- On macOS, logs an earlier version wrote to `~/Library/Logs/job-radar/ai-worker.{out,err}.log` are appended to
  `data/logs/ai-worker.{out,err}.before-upgrade.log` after the next successful install.
- `.dockerignore` leaves out everything `.gitignore` ignores, at any depth (editor folders, local demo and release-check
  files, nested `.env`, logs, test output), also for a build from the working tree (`pnpm stack:up`).

### Added

- **Query rotation:** collection starts with the queries waiting longest on its starting channel, so limited budgets reach the tail across cycles. Budget stops that already spent quota or money count as a turn, even with zero results; refusals before any request do not. `collect.query_rotation: false` restores config order; dry runs and history read failures use config order. Run records include usage and requested windows, and completed units report rotation summaries. Budgets and base windows stay unchanged.
- **Companies overview (`/companies`):** search and page through companies with open jobs, sort by job count, top score
  or latest first seen, open their jobs, and watch or unwatch with the Interests page kept in sync. Phone cards and
  sortable desktop headers share the URL state. Company exclusions link to the profile field; database-only watch
  flags are labelled without an Unwatch button. `ui.yaml: companies.page_size` controls the page size (default 50).
- **Company filter on `/jobs`:** a multi-select like city (`?company=…`, repeated for several), with job counts in the
  drop-down, stored in saved views and applied on the Today page and in the view trends. Click a company name in a job row
  or on a job's detail page to list that company's jobs. New `ui.yaml` keys `filters.company_options_max` (500) and
  `filters.company_options_visible` (50). Rolling back to an older version needs the `company:` keys removed from views
  first: see [docs/configuration.md](docs/configuration.md#company-filter-and-overview-uiyaml).
- **Settings** in `schedule.yaml` (not in the shipped file): `deploy.ai_worker_releases_keep` (3),
  `deploy.ai_worker_stop_timeout_seconds` (60) and `deploy.ai_worker_swap_timeout_seconds` (120). See
  [docs/configuration.md](docs/configuration.md#shipped-config-identity).
- **Doctor:** `ops.releases_lock` warns about a deploy lock left behind (owner, in-flight records, the `ps` command to
  check and how to clear it; a lock held by the deploy that runs the doctor is fine), `ops.ai_worker_swap_backup` about
  an unresolved worker switch backup, and `config.shipped` checks that the ai-worker runs from a release directory of
  HEAD.
- **CI:** an `upgrade-transition` job installs, switches, rolls back and uninstalls the real worker between releases of
  real commits under a service-manager simulator.
- **Doctor:** `config.shipped` warns when something is mounted on `/app/config`, or on a directory inside it, in a running
  container (it would hide the shipped config in the image, or that part of it). This part runs even when the database
  is down.
- **Reason sources** (off by default, `ai.yaml: scoring.evidence`): each fit reason and gap on the job page says whether
  the posting states it (with its own words and a jump to them in the job description), the AI inferred it, or the
  posting does not mention it. Quotes are checked against the posting; one that is not found counts as inferred. Nothing
  is re-scored; old scores show their reasons as before. Costs more output tokens per scoring call: see
  [docs/score-evidence.md](docs/score-evidence.md). Before rolling back to an older version, delete `scoring.evidence`.
- **Shipped config identity**: `pnpm config:check` prints a 12-character identity of the shipped defaults directory (a
  hash over its files). The web, the runner and the ai-worker report the identity they run with, and the new doctor check
  `config.shipped` shows it per process and warns when a report does not come from the process running now (another
  container, an older start, another PID). See [docs/configuration.md](docs/configuration.md#shipped-config-identity);
  new optional key `schedule.yaml: doctor.shipped_report_skew_seconds` (default 2).
- **`--help` of every `scripts/ops/*.sh`** prints its whole header comment, which names every option the script accepts
  (`uninstall-ai-worker.sh` gained `--help`).
- **Release directories for the host AI worker** (tooling only; the worker still runs from the checkout):
  `scripts/ops/prepare-release.sh <commit> --root <checkout>` builds a read-only
  `data/releases/ai-worker/<commit>/` from `git archive` plus a production `pnpm install`, under the deploy lock, and
  reuses one whose `.release.json` still matches. `src/ai-worker/release-guard.mjs`, loaded before tsx, refuses any
  module that resolves outside its release and checks the Node version, the synchronous module hooks and esbuild's
  binary. `scripts/ops/worker-heartbeat.ts` reports whether a given worker process holds the instance lock and has
  written a heartbeat since a given time. tsx is now a production dependency.
- **New optional keys** in `schedule.yaml: deploy`: `ai_worker_releases_keep` (default 3, at least 2),
  `ai_worker_stop_timeout_seconds` (default 60, at least 10) and `ai_worker_swap_timeout_seconds` (default 120, at least
  the stop timeout plus 10). Nothing reads them yet.

### Fixed

- Board discovery (Tavily, Brave) no longer drops the same searches every run when there are more than `max_queries_per_run`; it searches the ones that waited longest first.
- **Company career board scans:** `max_results` no longer hides stored jobs that the board still lists, which could
  mark them possibly closed after a week. The registry's "kept" count now means postings that passed the prefilter and
  fit within the cap. **Upgrade:** the first run after upgrading re-reads every board once (cached ETags are discarded).
- **Deploy and doctor no longer accept an old ai-worker heartbeat as proof the current service process is ready:**
  deploy step 12 waits for its lock, heartbeat and own shipped config report, up to the worker swap timeout
  (`--settle` overrides it; 0 skips the wait). An unconfirmed worker now makes deploy exit 2 even if doctor has no
  failures. Doctor warns for a current process without a receipt or a lock held by another worker; missing and stale
  heartbeats remain failures.
- **`cycle:run --dry-run` honours the stored budget, circuit and job state:** it ignored the database and started
  from empty state, so dry runs made billed requests past the monthly caps, hit channels with an open circuit and
  fetched the details of jobs already stored again. It now starts from the persisted monthly usage, circuit state and
  stored postings (read-only), as its help text said; it still writes nothing.
- **A job marked "no longer accepting applications" stays marked when its posting is parsed again or another channel
  merges into it:** the pipeline reset such a job to active (and made it eligible for scoring and push) whenever a
  source returned a changed posting or a new channel's copy. It now applies the same rule as the "seen again" step of
  maintenance; a plain possibly closed or closed job a source returns again is still active again. The ordinary link
  check no longer picks such a job either (it only sees that the link is live, not the page text), so it cannot reopen
  it when the watched recheck is off, the job is no longer starred or followed, or the settings failed to read once.
- **LinkedIn session channel, daily page limit reached part way through a query:** the postings that need no page load
  (already stored, or list cards when `fetch_details` is off) are still delivered after the limit instead of dropped, and
  the run is recorded as skipped (a budget stop, as with JSearch) instead of succeeded, so a query cut short is no longer
  used to mark jobs as possibly closed. The capped query itself now goes to the next channel of the cascade (guest, off by
  default); when it is the last query of its unit, the skip shows in the cycle's collect step (`partial`, or `failed`
  when nothing else succeeded). "Recommended for you" stopped by the limit counts as read only when it kept postings.
  See [docs/linkedin-session.md](docs/linkedin-session.md#when-the-daily-page-limit-is-reached).
- **Debug logging could not be turned on:** every process logged at `info`, so the diagnostic records (AI provider
  checks, skipped providers, HTTP retries, ignored Telegram chats) never appeared. The level is now `schedule.yaml`
  `logging.level` (default `info`, followed without a restart) or `JOB_RADAR_LOG_LEVEL`, which wins; it applies to the
  web app, the runner, the ai-worker and `pnpm cycle:run`, and the AI provider test and the requests outside a cycle
  (translation, breakdown, salary lookup) now hand their logger to the providers. Remove the `logging` block from
  `data/config/schedule.yaml` before rolling back to an older version. See
  [docs/configuration.md](docs/configuration.md) ("Log level").
- **Building no longer needs Google Fonts:** the fonts (Archivo, Archivo Black, IBM Plex Mono, Noto Sans SC) are
  self-hosted from pinned npm packages, so `pnpm build` and the image build work behind a network that blocks Google
  and no longer fail when the font download does. The pages look the same (same families, weights, character coverage
  and loading). The Dockerfile compiles with `RUN --network=none`, so every image build proves it. The font licences
  (SIL OFL 1.1) are in `licenses/fonts/` and in the web image.

### Security

- **AI salary figures cannot affect benchmarks or filters.** Job Radar has not checked the figures or sources given by
  the AI. Old benchmark tables containing any AI figures are hidden in full until recomputed from postings; a failed
  recomputation leaves them hidden. Source links on the configured salary-site list are still unverified.
- **Dependency and runtime security updates:** Next.js 16.4.2 and React 19.3.1 (published advisories in `use cache`, SVG
  image optimisation and Server Actions handling), the MCP SDK 2.3.1, and Vite 8.3.5 and `ip-address` 10.7.4 for the
  development and mail-client chains. The Node.js floor is raised to 22.23.4 for the 2026-10-21 Node security release;
  rebuild the images with `--pull` so the containers get it too.

### Documentation

- "Possibly closed" is now described as what it is: a time-based hint judged per channel (not per search query), with the
  link check as the evidence (a live link reopens the job; it closes only when every link returns 404 / 410). A job seen
  again becomes active again, except when its page says it no longer accepts applications or you closed it yourself. See [docs/sources.md](docs/sources.md#how-jobs-get-marked-possibly-closed).

## [2.0.1] - 2026-10-11

### Upgrade notes

- **https users sign in once more.** Over https the session cookie is now `__Host-jr_session`; sessions from before the
  upgrade are not carried over, so every device that comes in through `tailscale serve` (or another https proxy) shows
  the login page once. Plain http sessions stay valid.
- **`pnpm start` / `pnpm dev` with a web password:** the host keeps its no-password access only with
  `JOB_RADAR_WEB_BIND=127.0.0.1` in `.env` (the server then listens there). Without it the server listens on every
  interface and every request needs the password, `http://localhost` too; `pnpm run doctor` warns. `pnpm start` now
  needs the development dependencies (`tsx`). Compose installs need nothing.

### Added

- **README screenshots and a demo GIF**, generated from fictional demo data with `pnpm demo:shots`. A leak guard refuses
  to write the images if a page shows a machine path, a user name or a private string.
- **Signed releases:** the maintainer's public key is published as [docs/signing-key.pub](docs/signing-key.pub);
  `scripts/ops/deploy.sh --ref <tag> --verify` checks the tag against it before deploying.
- **Accessibility:** a skip-to-content link, a page title on every page (English and Chinese), and an end-to-end
  accessibility test.

### Changed

- Documentation fact-check: `.env.example` gaps, Linux and systemd coverage, Compose 2.24 or newer, the PUID/PGID step,
  and `pnpm run doctor` everywhere (plain `pnpm doctor` is pnpm's built-in command).

### Fixed

- Saving the settings page writes only the values you changed into `data/config`, so later changes to the shipped factory
  defaults reach you. `setup --status` no longer writes any files.
- The Docker image builds again: `next build` type-checks only the app sources, not the end-to-end tests that the image
  does not contain.
- Light theme: the error red is darker (`#c8322a`) for 4.5:1 text contrast; keyboard and screen-reader fixes in the
  settings tabs, quick filters, top bar, heading order, landmarks, scroll regions and the command palette; larger
  kanban targets on mobile.

### Removed

- The one-off migration helpers for private 1.x installs: `pnpm sources:migrate`, `pnpm models:migrate`,
  `pnpm ai:usage-backfill`, and the read-only compatibility mode for the old `channels.yaml` + `companies.yaml` pair. The
  old files are now ignored, and `ai.yaml` no longer accepts the old `providers.*.models` / `pricing` keys. Upgrade a 1.x
  install with the 2.0.0 release first.

### Security

- The local login exemption no longer trusts request headers a client can send: it is on only while
  `JOB_RADAR_WEB_BIND` is a loopback address and the web listens there.
- Failed-login limits: the per-source limit uses the address the nearest proxy saw; the limit across all sources is a
  growing wait instead of a lock, which a browser that is still signed in skips; both are logged.
- "Sign out everywhere" on the settings page ends every web session (session generation in
  `data/config/.web-session-generation`).
- Link checks and the recheck of watched jobs check the resolved address when they connect (no DNS rebinding into the
  Docker network or the host), with the configured time limit.
- Config and profile files seeded on first run are owner-only from the moment they are created.
- Docs: when to set `JOB_RADAR_WEB_LOCAL_LOGIN=1` (TCP forwards, containers on the same network).

## [2.0.0] - 2026-10-10

The first public release of Job Radar: a self-hosted, customisable job radar (AGPL-3.0-only). It collects postings from
many sources, filters and scores them against your own profile with the AI subscription or API key you already have, and
tracks your applications. Everything that used to be specific to one person (market, language, signals, sources, AI
providers) is now configuration, set up in a first-run wizard and on the Settings pages.

Coming from a private 1.x or 0.x install? Read the upgrade notes below and [docs/upgrade.md](docs/upgrade.md) before you
deploy.

### Upgrade notes

Deploy with `scripts/ops/deploy.sh --ref v2.0.0` (run it with `--dry-run` first). It backs up the database, migrates the
configuration and the database, and restarts the services. In addition:

- **Scripts moved.** `deploy.sh`, `backup.sh`, `restore.sh`, `install-ai-worker.sh` and `uninstall-ai-worker.sh` now live in
  `scripts/ops/`; the old `scripts/` paths are gone. Update cron jobs, shell aliases and notes that call them. The launchd
  label changed from `de.jobradar` to `io.jobradar`; the deploy migrates the old agent by itself.
- **Configuration moved.** `config/` now holds read-only defaults that ship with the product; your own configuration lives
  in `data/config/` (not in git) and wins over the defaults; the settings pages write only there. The deploy creates it.
  If you edited files in `config/` on 1.x, keep a copy of that folder and run `pnpm config:init --from <copy>` once.
  `models.yaml` and `pipeline.yaml` now follow product updates unless you put your own copy in `data/config/`. See
  [docs/configuration.md](docs/configuration.md).
- **Renamed configuration keys** are migrated by the deploy (`pnpm config:migrate --write`; originals are kept in
  `data/config/.backup/`): `salary_floor_eur_year` is now `salary_floor_year`, `german_penalty` / `german_gap` are
  `language_penalty` / `language_gap`, `salary_bucket_eur` is `salary_bucket`, and `push_min_score_with_t1_t2` is
  `push_min_score_high_value`. Old links with `hideGerman` or `t12` keep working. The full list is in
  [docs/market-packs.md](docs/market-packs.md).
- **Two steps you run yourself:** `pnpm sources:migrate --write` merges `channels.yaml` and `companies.yaml` into the new
  `sources.yaml` (until then the sources are read-only), and `pnpm models:migrate` moves model lists and prices out of
  `ai.yaml` into the new model catalog `models.yaml`.
- **The web only answers to known host names.** Besides `localhost` and `*.ts.net` (Tailscale), a request addressed to any
  other name gets HTTP 421. If you reach the dashboard through a reverse proxy, a LAN name or a LAN IP, list that name in
  `JOB_RADAR_ALLOWED_HOSTS` in `.env`. The web is published on `127.0.0.1` unless you set `JOB_RADAR_WEB_BIND`; opening it
  to the network needs a password (`pnpm web:password`). Settings pages can no longer change protected keys (commands,
  endpoints) unless you set `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1`.
- **Linux:** the containers now run as `PUID:PGID` from `.env` instead of root. Fix the ownership of `data/` and `.auth/`
  once before upgrading (commands in [docs/upgrade.md](docs/upgrade.md)).
- **Existing files keep their values.** The new defaults below (providers, channels, scoring order, Telegram) apply to new
  installs only; your `data/config/` is never rewritten except by migrations. The codex CLI now needs at least the version
  in `ai.yaml: providers.codex_cli.min_version`; `pnpm run doctor` tells you.

### Added

- **First-run setup wizard** (`/setup`): language, market, profile, target roles, sources, AI, Telegram, then a check and the
  first cycle. Every step writes the configuration files directly and can be skipped or reopened later; scheduled
  collection waits until you finish. `pnpm run setup` does the same without a browser. Existing installs count as set up.
- **Market packs**: country, cities, currency, local-language requirement, local channels and rules are a swappable pack
  (`generic` and `de` ship). The profile has a market section, remote scope is "home country / worldwide / chosen regions",
  channels that do not belong to your market are skipped and marked on the sources page. Salary parsing and the salary
  floor know more currencies (CAD, AUD, NZD, SGD, HKD, JPY, CNY, INR, KRW, BRL, MXN, ZAR, AED, ILS, TRY) with rough rates
  in `pipeline.yaml`; the market form says when a currency has no rate.
- **Languages**: the interface language comes from `messages/` (add a language by adding a file), and `language.yaml` sets
  the default interface, AI output, translation target, Telegram and command-line language. Scoring criteria (what you
  value most, what you cannot accept, bonuses) are editable on the AI settings page, with the number of scores a change
  would redo.
- **Layered configuration** with `pnpm config:init`, `config:migrate` and `config:check`, a `config_version` per file and
  automatic backups before a migration. A model catalog (`models.yaml`) lists providers, models, prices and reasoning
  levels, updated to the current models and prices (including `ultra` reasoning for codex).
- **More settings in the browser**: a redesigned AI tab (providers with subscription and API rows, routing and per-task
  assignment, limits, scoring), an Application flow tab (hide unused statuses, reminder timeouts, work modes, contract types,
  résumé tool), an Advanced tab to edit any configuration file as text (live validation, diff against saved and default,
  protection against overwriting concurrent changes, backup before saving, restore defaults), an Actions tab, Interface,
  Salary and Breakdown tabs, and a 24-hour timeline of processing rounds.
- **Custom signal categories**: the signals on your interest list are no longer fixed to four tiers; add, rename, reorder,
  hide or restore categories, each with a type (amount, keyword, tag), weight, icon and colour. **Custom interest points**:
  preset categories on `/interests` that you can try on recent jobs first (rules only, no AI call).
- **Sources**: a source registry page (`/sources/registry`) lists every channel and every company board with its status and
  a one-line reason; enable, add, edit, remove, import and export from there. "Collect now" and "Test" buttons per channel,
  a test button per AI provider, and a Telegram test message. Tavily search discovers new company boards (Brave remains as
  an off-by-default option). Channels reuse details of postings they already stored instead of requesting them every cycle.
- **AI usage page** (`/sources/ai-usage`): every AI call with model, tokens, duration, outcome, actual spend and
  API-equivalent cost, grouped by day, model, provider and task, with CSV export.
- **Job analysis**: a job breakdown card (responsibilities, tech stack, experience, soft skills, languages, each marked
  required or nice-to-have with a quote from the posting; off by default); **AI trap detection** that flags hidden or
  misleading text aimed at AI readers (hidden text, comments, invisible characters, "if you are an AI" instructions) in the
  list, the detail page and Telegram, strips it before text is sent to an AI, and never changes scores or the original
  text; a **salary benchmark** card (percentiles by role family, level and city, with links to salary sites) and an
  on-demand "Look up salary" button where an AI searches public pages and cites its sources (cached, daily cap, off by
  default; the only AI call with web access).
- **Working with the list**: sort by clicking a column header (kept in the URL); seen / unseen jobs with "only unseen",
  "mark all as seen" (undoable) and a "new since your last visit" divider; mark a job as closed manually (undoable) with a
  Closed view, and watched and in-progress jobs recheck their source link now and then (respecting robots.txt, rate
  limited; only a 404 or 410 closes a job, closing phrases only mark it "possibly closed"); multi-select filters for source,
  city, work mode, contract and status; favourites with a notes page; "View original" separate from "Mark as applied".
  Links from Insights to the job list include all statuses, so the numbers match.
- **Optional web password** (`pnpm web:password`, a `/login` page, signed session cookie; loopback access needs no login),
  configurable bind address and port, several instances on one machine (`COMPOSE_PROJECT_NAME`, `JOBRADAR_PG_VOLUME`), and a
  first run on Linux (systemd user unit for the AI worker, hardened containers).
- **Telegram**: allowed user IDs.
- **AI provider disclosure**: the setup wizard lists the enabled providers that will receive posting text, and Settings
  shows which providers each task actually uses. The consent dialogs for scraping channels link to the scraping docs.
- A profile that is too empty to score no longer fails silently: a banner on Today and the profile page says what is
  missing, and the doctor reports it.
- `scripts/ops/deploy.sh --ref <tag|branch>` deploys a release tag such as `v2.0.0` (the recommended way to upgrade and to
  roll back). New guide `docs/upgrade.md`: upgrade, what the deploy does, rollback and a complete uninstall. Doctor checks
  for the configuration layers, the market, the source registry, Docker's disk location and free space on the system disk.
- `scripts/ops/` (deploy, backup, restore, host AI worker install), `scripts/release-check.sh`, and `scripts/validate.sh`.
  The release check also scans the whole commit history for secrets (pinned gitleaks version) and fails on private
  planning ids in the repository. Releases are signed annotated tags.
- Documentation: a new README, installation guide and FAQ (English and Chinese), `docs/privacy.md` (what is stored, what
  leaves your machine, the data policy of each AI provider, how to remove everything), `docs/commercial-use.md`, `docs/ci.md`,
  a `NOTICE` file, a non-affiliation disclaimer and a Developer Certificate of Origin sign-off for contributions
  (`git commit -s`). `SECURITY.md` points to GitHub's private vulnerability reporting.
- The sidebar shows the running version with a link to the source code.

### Changed

- **New interface**: a bolder design (ink outlines, hard shadows, a colour-blind-checked palette; light "paper" theme by
  default, dark "terminal" theme; saved theme choices are kept), new fonts, a terminal-style sidebar with processing-round
  status and counts, a ticker of new jobs, charts and meters on Today, job list, job detail, applications board, sources,
  insights, profile and interest list, keyboard-operable board, and a reduced-motion mode that skips animations.
- New installs: DeepSeek and MiMo are switched off, `api_order` tries Anthropic first, and codex-cli has a daily cap of 200
  requests. Two models are marked deprecated (`deepseek-v4-flash`, `mimo-v2.5-pro`).
- New installs: LinkedIn guest search, Indeed and StepStone are switched off, and so is `linkedin_fetch_description`; Telegram,
  job breakdown and salary lookup are off too. Switching on a channel that scrapes a site or drives your account shows a
  terms-of-service notice and needs your confirmation in the setup wizard and on `/sources/registry`.
- New installs: the seniority part of the scoring order follows `seniority` in `preferences.yaml`
  (`ai.yaml: scoring.priority.seniority_from_preferences: true`) instead of always ranking senior postings first. An
  existing `ai.yaml` without that key keeps the old table; set it to `true` on the Settings page to switch.
- The shipped defaults are neutral: no personal paths, host names or deployment values, no AI-engineering keywords, no preset
  list of European companies, no fixed city; the example setup (ten neutral career boards) is an optional preset.
  `notify.yaml: public_base_url` is empty, `ai.yaml: docker_data_path` is unset.
- `scripts/ops/deploy.sh` has no machine-specific volume check; set `JOB_RADAR_DEPLOY_VOLUME=<mount point>` to refuse a
  doubly mounted external volume. It prunes the Docker build cache after deploying (`--no-prune` skips it).
- The "Tailor résumé" buttons (job detail header and Telegram) only appear when `resume_kit_path` is set in `resume.yaml`.
  The doctor no longer warns about a Telegram push you have not enabled.
- The AI worker logs to `data/logs/` with size-based rotation; the doctor measures the volume Docker really uses.
- Settings → AI says a CLI provider is "available" instead of "signed in" (the check only sees that the CLI runs), and
  "login failed" after a real login error. The setup readiness check counts the AI providers that are on and names those
  without a key.
- The setup wizard's market step fills in the currency, the cities and the profile city for the chosen country, as long as
  you have not edited them yourself.
- The student-role exclusion in the wizard uses neutral examples (working student, internship, thesis).
- Links from the app to the user guide point at the docs of the running version (`blob/v<version>`), not `main`.
- The docs are platform-neutral (README platform notes with WSL2) and say consistently that a subscription CLI, an API key
  or both can be used; `getting-started.html` is now the guide for after the setup wizard.

### Fixed

- Only one ai-worker runs per database. A second one (for example `pnpm ai-worker --once` next to the launchd service) says
  which process holds the lock and exits with code 3 before it touches the queue, so a running request is never queued again
  and run twice.
- A deploy no longer loses work in flight. An AI request or a control request cut off by a restart of the ai-worker or the
  runner goes back to the queue and runs again (`ai.yaml: host_worker.requeue_interrupted_max`, default 3).
  `scripts/ops/deploy.sh` waits for a running cycle before it recreates the containers (`schedule.yaml:
  deploy.drain_timeout_seconds`, `--no-drain`, `--drain-timeout`), also before a database migration adds new request types,
  and a cycle cut off anyway is run again by the runner's catch-up.
- `scripts/ops/restore.sh --latest` picks the newest backup by the date in the file name, prints the file and its age, and
  asks for confirmation when it is older than `schedule.yaml: backup.max_age_hours`; `--list` shows all backups. Backups
  now include your configuration and profile (a `.config.tgz` next to the dump), wait for a running cycle, are flushed to
  disk and validated with `pg_restore --list` before they count, fail when any write fails, are readable by their owner only,
  and leave out macOS `._*` files. A restore goes into a temporary database first and only then switches; if it is
  interrupted the services are restarted, the temporary database is dropped and a renamed main database is renamed back.
  A migration is preceded by its own backup.
- Host commands (`pnpm ai-worker`, `cycle:run`, `refilter`, `sources:list`, `auth:linkedin`, ...) work without a
  `DATABASE_URL` in `.env`: they default to the local compose database. An explicit `DATABASE_URL` still wins.
- The ai-worker and the runner exit within a grace period after SIGTERM instead of hanging, a stuck disk measurement no
  longer stops the heartbeat, and settings changes (such as the market) reach the runner and the ai-worker without a
  restart.
- A market without an Indeed country no longer makes every JobSpy channel fail: only Indeed asks for one. Channels without
  their key are skipped instead of counted as failures.
- Recruiter-placed jobs (direct hire through an agency) are no longer excluded as temporary agency work; they are kept and
  tagged. Run `pnpm reprocess` once to reclassify jobs already stored.
- Setup wizard and Advanced editor fixes: remote scope follows the market, switching back to the generic pack keeps the
  country, an existing install no longer shows seven unfinished steps, skipping Telegram turns the push off; changing your
  location on the profile page updates the search cities.
- Salary and display fixes: one consistent salary notation and median definition everywhere, benefit amounts are no longer
  read as salary, OTE and other-region notes on the detail page, a stable Today list that keeps the previous round's
  postings, and clearer messages when a round partly failed.
- The detail page remembers a running breakdown or translation after a reload, shows the real model name, and the translate
  button names the target language. Trap findings the AI judged harmless no longer show a warning, and the trap reason
  follows the AI output language.
- "View original" opens the posting itself on company career pages instead of the application form.
- The Telegram button labels in the docs match the real ones; the backup guide's anchors and new-machine steps are fixed.
- Translate, breakdown and salary lookup requests share the provider health of the runner and the ai-worker: a provider
  at its daily cap or cooling down is skipped, and a login failure shows on Settings and `/sources`.
- `pnpm run doctor` on a fresh install no longer fails on LinkedIn when no LinkedIn channel is set up; the installation guide
  lists the warnings to expect.
- The salary level card says the comparison is not computed yet before the first benchmark. The salary lookup counter
  updates without a reload, the button is disabled with the reason once the daily limit is used, and a login error names
  only the providers the lookup can use.
- The "filtered" count on Insights opens exactly those filtered-out jobs on `/jobs`.
- The README and `sources.yaml` list Google Jobs (through the JobSpy sidecar) among the scraping sources.
- Host commands print the missing `.env` notice once instead of twice.
- Unit tests and the setup command can no longer connect to a real database.

### Security

- The AI CLIs never get tools from the configuration. codex switches off every feature the installed version lists
  (`codex features list`) except a few that only affect the API connection, plus a fixed list of tool features, on every
  call; web search, the apply-patch and image tools are off and approvals are "never". `disable_features` can only add
  names. claude runs with no tools and with `--strict-mcp-config`. Model names that could be read as options are refused,
  and the doctor warns when the installed codex is older than the minimum version.
- Besides the web-side lock on protected keys, the ai-worker and the runner check the values again where they are used (a
  file edited by hand or with `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` gets the same checks): `providers.*.command` must be
  the `claude` / `codex` executable, `codex_cli.config_overrides` keeps only the context switches set to `false`, and API
  keys, the Telegram token and the Gmail login are only sent to the vendors' own hosts (Gmail: `imap.gmail.com:993` with
  TLS), never following a redirect. To use a proxy or gateway of your own, set `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` in
  `.env`. The doctor's `config.guards` check lists anything ignored or refused.
- Every route checks the `Host`, `X-Forwarded-Host` and `Origin` headers against an allowlist (HTTP 421 otherwise;
  `JOB_RADAR_ALLOWED_HOSTS` extends it), state-changing requests must be same-origin, and responses carry security headers (and no `X-Powered-By`).
- Optional web password with hashed storage and signed session cookies; configuration files are written with owner-only
  permissions and saves detect concurrent changes; containers run as an ordinary user with reduced privileges.
- CSV exports escape cells that start with a formula character, and the link checker refuses internal and private addresses.

## [0.1.0 - 1.x]

Private development releases of the original single-user tool: the collection channels, the processing pipeline, AI
scoring and translation through the host worker, the Telegram push, application tracking, statistics, backups and the
health check. They were never published; 2.0.0 is the first public version.
