# Changelog

All notable changes to Job Radar are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
