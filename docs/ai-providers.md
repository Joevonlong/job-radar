# AI providers and the host AI worker

AI runs through a subscription CLI (`claude`, `codex`), a pay-per-token API key, or both; you choose. Every AI call, whichever you use, is executed by the `ai-worker` on the host, and subscription logins and API keys are never put inside the containers. What each provider receives is listed in [privacy.md](privacy.md).

## Subscription or API key

| | How | Cost |
|---|---|---|
| **Subscription CLI** (default) | The ai-worker runs `codex` and `claude` with the logins you already have (`codex login`; `claude`, then `/login`). | Nothing per token. Daily caps (codex 200, claude 100 calls) protect your plan's quota. |
| **API key** (optional) | Put `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` or `MIMO_API_KEY` in `.env`. DeepSeek and MiMo also need switching on in `ai.yaml`. | Pay per token, stopped by `monthly_api_budget_usd` in `ai.yaml`. |

Use either or both; API providers are only tried after the CLIs. `pnpm ai:probe` shows which providers work right now.
Consumer subscriptions are personal licences: read [commercial-use.md](commercial-use.md) before using them for anyone
but yourself. Usage and cost: [ai-usage.md](ai-usage.md).

## What runs where

| Process | Location | What it does |
|---|---|---|
| runner | Docker container | collect → pipeline → filter → signals (rules) → maintenance. The `ai` and `notify` steps are not executed; it only writes a `run_ai` request (`ai.yaml: execution: host`, the default) |
| web | Docker container | The "Translate" button on the web page writes a `translate_job` request and polls its status; "Re-score" writes a `rescore_stale` request. It never calls any AI itself |
| ai-worker | Host machine (a launchd agent on macOS, a systemd user unit on Linux; elsewhere any process supervisor) | Handles `run_ai` (score → signals → translate → breakdown (only when `breakdown.yaml` is `auto`), then notify), `translate_job`, `breakdown_job` (the "Break down this job" button on the detail page), and `rescore_stale`. Writes its own heartbeat (`runner_heartbeats.process = 'ai-worker'`) |

Requests all live in the `control_requests` table. The runner and the ai-worker each claim only their own kinds (`src/lib/control/kinds.ts`), so restarting one never marks the other's in-flight work as failed. A `run_ai` request is only claimed after the cycle it points to has finished (the cycle summary is written last). When the worker is done it writes the real `ai` and `notify` sections back into that cycle's summary, replacing the `delegated` placeholder the container left behind.

When several finished cycles are queued, the worker processes the AI work of each and combines their job notifications
into the last claimable cycle's digest. A cycle that is still running cannot hold back that digest; alerts are sent
immediately. If sending the digest fails, the request stays pending and retries after `host_worker.poll_seconds`, without
repeating completed AI work. Its original candidate window is retained even if delivery resumes much later or after a
worker restart. `--once` exits when no request is claimable; a failed digest waiting for its retry time remains queued
for the next worker run.

**Rule**: any request kind that calls an AI is claimed only by the ai-worker. There is exactly one list of kinds: `AI_CONTROL_REQUEST_KINDS` (`src/lib/db/repos/control-requests.ts`), and the real handlers are registered in one place, `registerAiControlHandlers()` (`src/lib/control/ai-handlers.ts`). To add a new kind (for example `run_suggest` or `score_jobs`): add the value to the database enum (migration) → add it to that list → register a handler. A unit test fails if the enum contains a kind that has not been classified.

With `ai.yaml: execution: container` everything works the old way: the runner runs AI and push notifications itself inside the container, and also claims `translate_job` / `rescore_stale`. This requires you to put your subscription tokens or API keys into the container yourself (compose blanks these variables by default; to use them, write a `compose.override.yaml`). Not recommended.

## Which providers receive job text

Only providers that are switched on (`providers.<id>.enabled`) are ever called, and each AI task tries them in turn: the task's own
`tasks.<task>.order` if `ai.yaml` sets one, else the global `order` (`api` stands for `api_order`). When a provider is unavailable
(not installed, signed out, cooling down after a limit, over its daily cap, no key) the next one in the list takes over, so
**every provider in a task's list can receive that task's text**: the job posting, and for scoring also the profile fields the prompt
needs. Settings → AI → Routing shows this list per task, read from the saved `ai.yaml`; the setup wizard's AI step
explains it before you switch providers on. Subscription CLIs (`claude`, `codex`) send the text to Anthropic / OpenAI through
your own account; API providers (Anthropic, DeepSeek, Xiaomi MiMo) send it to the vendor's API. The web-search task
(`salary_lookup`) only uses providers that can search the web. What exactly leaves your machine, and what each vendor does with it, is
in [privacy.md](privacy.md). To keep text away from a vendor, switch its provider off.

## Login

See section 6 of [host-setup.md](host-setup.md): `claude` → `/login`, `codex login`. The provider order, which model to use, and timeouts are in `data/config/ai.yaml`; which models exist and their prices are in `config/models.yaml` (the model catalog). `pnpm ai:probe` shows which providers are available right now. You can also click "Test" on a provider in the "AI provider health" section of `/sources` (the ai-worker sends the same tiny request; see [settings.md](settings.md)). The pay-per-token API providers (Anthropic / DeepSeek / MiMo) remain implemented, but are only selected by routing when you have put a key in `.env`, and they are subject to `monthly_api_budget_usd`. DeepSeek and MiMo ship switched off (`enabled: false`); set `enabled: true` for the one you want. Their keys only go to the vendor's own host (see [What the ai-worker does not take from ai.yaml](#what-the-ai-worker-does-not-take-from-aiyaml)). The keys are read by the ai-worker on the host; inside the runner container these variables are explicitly blanked.

## Configuration

```yaml
execution: host          # host | container
host_worker:
  poll_seconds: 5            # how often to check the queue
  max_requests_per_poll: 10  # how many requests to handle per poll
  heartbeat_seconds: 15
  offline_after_seconds: 180 # no heartbeat for this long: /sources shows "not responding" and the runner sends a Telegram alert
  disk_check_minutes: 10     # interval for measuring free disk space on the host (measures the volume holding Docker's DataFolder; see the disk section of deploy.md)
  # docker_data_path: /Volumes/<external-drive>/.docker-data   # optional: set the Docker data directory directly; if omitted, Docker's settings file is read, which under launchd may be blocked by a macOS privacy prompt (the measurement times out and the /sources low-space warning does not update). `pnpm run doctor` prints the value to use as disk.docker_location
  log_max_mb: 10             # rotate data/logs/ai-worker.*.log once it exceeds this many MB
  log_keep: 3                # how many old logs to keep (.1 is the newest); 0 = just truncate
translation:
  chunk_chars: 2500          # length of the chunks a long JD is split into
  chunk_timeout_seconds: 90  # the longest a provider may take on one chunk
  glossary:                  # fixed translations: source term -> translation (identical = keep the English); only terms present in a chunk are sent
    Solutions Engineer: Solutions Engineer
```

## Usage control and cooldown

Like a desktop client (pick providers, order the fallbacks, set usage caps), which subscription to use, who goes first, and how much to use are all configured in `data/config/ai.yaml`, and can also be changed on the AI tab of the settings page:

- **Order**: `order`, default `[codex-cli, claude-cli, api]`, with codex first. The claude subscription is shared with your own interactive use, so it comes later. Each task kind can override this with `tasks.<task>.order`.
- **Switch and daily cap**: every `providers.<name>` has `enabled` (false = routing never tries it) and `daily_request_cap` (the maximum number of model calls per day, failed ones included; 0 = unlimited). By default claude-cli is 100 per day, codex-cli 200 per day, and the API providers are unlimited (their `monthly_api_budget_usd` still applies). The API tier is tried in `api_order`, by default `[anthropic, deepseek, mimo]`. "A day" follows the time zone in `schedule.yaml`.
- **Cooldown**: when a provider reports a quota / session limit / rate limit ("hit your session limit", "usage limit", 429, etc.), every process (runner, ai-worker) skips it until the recovery time stated in the error message. If that cannot be parsed, it is cooled down for `cooldown.default_minutes` (default 60 minutes), at most `cooldown.max_minutes`. The state is stored in `runtime_state` (key `ai_provider:<name>`), so no migration is needed. The recovery time is interpreted in the local time zone of the machine running the ai-worker.
- **Usage cap (subscription CLIs)**: `quota_guard` is Job Radar's own cap on how often it calls claude-cli and codex-cli. It **only counts Job Radar's own calls** (`ai_usage`, failed ones included); the subscription is shared with your own use in the terminal and the web apps, which it cannot see, so the cap can only trigger later than the real limit, never earlier (a real limit reached anyway is still caught by the cooldown). Per CLI (`quota_guard.providers.codex_cli` / `claude_cli`): `hard_requests` calls within the rolling `window_hours` (default 5) pause the CLI for every task, your own clicks included, until enough calls have slid out of the window (it resumes below `resume_ratio` × `hard_requests`, default 0.8); `cycle_request_cap` limits the calls of one processing cycle, the rest of that cycle waits for the next one. **Your own requests (score now, translate, breakdown, salary lookup, test) are not held back by the per-cycle cap**, only by a full window. When the cap skips the CLIs a task **does not switch to the paid API providers** (`fallthrough_to_api: false`, the default); the error cooldown above keeps falling through to the API as before. 0 turns a cap off; `enabled: false` turns the whole cap off (behaviour as before it existed). Telegram gets one alert when a window fills or a provider reports a limit, and one when it is usable again (`notify_recovery`); a state that lasts is never repeated (`alert_dedupe_hours` only stops a flapping state). The per-cycle cap sends no alert: the cycle summary's last line says how many new jobs wait for a score and from when. The state is stored in `runtime_state` (key `ai_quota:<name>`), no migration. Defaults = 1.5 × the maximum seen in the maintainer's own usage (codex-cli 861 per window / 554 per cycle, claude-cli 399 / 399). Plans differ: tune them in Settings ("Limits" block of the AI tab); `pnpm ai:usage-stats` prints your own maxima and suggested caps (read only).
- **Per-cycle time budget**: `cycle_budget_minutes` (default 30) limits the time scoring and signals may take in one cycle; whatever exceeds it is left for the next cycle. When this cycle has no new jobs, `idle_cycle_budget_minutes` (default 10) applies. 0 = unlimited. When every provider is cooling down / disabled / at its cap, the AI step is skipped outright (the cycle summary states the reason).
- **Task `breakdown`**: job breakdown. By default it follows the global order (codex first, for the same reason as translation: the output is long, and the subscription CLIs have no 4096 output cap). Use `tasks.breakdown.order` to order it separately, and `reasoning_effort_by_task.breakdown` for codex reasoning effort. Disabled by default; see [breakdown.md](breakdown.md).
- **Task `salary_lookup`**: the on-demand salary lookup ([salary.md](salary.md)), the **only** AI call that may use a tool: web search. Default order `[claude-cli, anthropic]`; only providers that can search the web are tried (DeepSeek and MiMo are skipped), and the list of tasks allowed to search is fixed in the code (`src/lib/ai/web-tasks.ts`), so no setting can give another task web access. codex-cli can be added to `tasks.salary_lookup.order`, but its web search cannot be limited to domains (the settings page says so).
- **Push before translation**: the ai-worker does scoring and signals first, pushes immediately, and translates last (translation is marked `late` and does not affect the push content).
- **Checking status**: "AI provider health" on `/sources` shows each provider's state (available / not configured / disabled / not logged in / daily cap reached / Job Radar's usage cap reached until when / cooling down until when), Job Radar's own calls in the usage cap's window against `hard_requests`, today's request count against the cap, and the latest success and failure; each row has a "Test" button. The order list and dropdowns on the AI tab of the settings page use the same state to mark unavailable providers.
- **Model catalog**: two files share the work. `config/models.yaml` is the **catalog** (which models each provider has: `id`, display name `label`, `aliases`, the API `price`, codex `reasoning_efforts` / `cli_default`, `deprecated`, `notes`), and `data/config/ai.yaml` is the **selection** (`providers.<name>.model` / `strong_model`, `tasks.<task>.models`). `ai.yaml` still loads on its own and does not depend on `models.yaml`; a selected model must be in the corresponding provider's catalog, which is checked by `pnpm config:check` (with an extra `ai.yaml ↔ models.yaml` line) and when the settings page saves: a model not in the catalog / a codex reasoning effort the model does not support = error; selecting a deprecated model = warning.
  - **Per-task models**: `tasks.<task>.models` maps "provider id → model id", and can only be set for providers listed directly in that task's own `order` (not those that `api` expands into). When routing reaches that provider it uses this model, otherwise the provider's default model. Each task-override row on the settings page is a "provider + model dropdown".
  - **Cost**: the model name in an API reply is looked up for a price first by the catalog `id`, then by `aliases`. If neither matches, the most expensive input / output price in that provider's catalog is used (better to over-count than to let the monthly budget leak), and the log has a warning suggesting you add an `aliases` entry. Subscription CLIs are always 0.
  - **Broken catalog**: before trying an API provider, routing checks that the model about to be used has a price in the catalog. If not, or if `models.yaml` cannot be read, that API provider is skipped (recorded as "not configured", with the reason in the message); subscription CLIs are unaffected. The file is re-read before every call based on its modification time, so a bad edit is noticed immediately and the next call recovers once it is fixed.
  - For detailed use of the settings page, see [settings.md](settings.md).

## Usage statistics

Every model call (including failures, and retries after unacceptable output) writes one `ai_usage` row: model, fine-grained tokens (cache read/write, reasoning), duration, outcome, actual spend, equivalent API cost, and the related job. Tokens that a CLI did not report are recorded as "unknown", not 0. `/sources/ai-usage` summarises them, and `pnpm ai:usage-backfill` fills empty values. A subscription model in `models.yaml` can have `equivalent_price` (with a `source`), and an API model's `price` can have `cached_input_per_mtok` / `cache_write_per_mtok`. See [ai-usage.md](ai-usage.md) for the full description and the configuration to add.

## Checklist for a new model release

When a vendor ships a new model (no restart needed; it is hot-reloaded about 5 seconds after saving; the steps are also at the top of the shipped `config/models.yaml`; `models.yaml` is a shipped file, so copy it to `data/config/models.yaml` first and edit your copy):

1. Under the matching provider's `models` in `data/config/models.yaml`, add an entry: `id` is the model name from the vendor docs, `label` is the display name.
2. API providers (anthropic / deepseek / mimo) must have a `price` (USD per million tokens, input and output, per the official site); subscription CLIs get no `price`.
3. Run `pnpm config:check` and confirm there are no errors.
4. Try it once: `pnpm ai:probe --provider <provider> --model <id>` (`--model` must be paired with exactly one `--provider`; `catalog=exact|alias|unknown` in the output says whether the model name in the reply was found in the catalog).
5. Refresh `/settings`, pick it in the "Model" dropdown of the provider's section on the AI tab, and save.

To retire an old model: first switch to another model on the settings page, then add `deprecated: true` to it (the dropdown stops listing it; if it is currently selected it is still shown, marked "deprecated", and `config:check` only warns); delete the entry once you are sure nobody uses it. When a vendor reply reports a dated snapshot name, add it to that model's `aliases`.

## How codex-cli is invoked, and the quota-saving settings

New keys under `providers.codex_cli` (all in `data/config/ai.yaml`; key names and feature names may only match `^[a-z0-9_.]+$`, and an invalid configuration is rejected, so no extra arguments are ever stuffed into the command line):

- **Tools are always off**, whatever `trim_context` says. Codex has no tool allowlist for `codex exec`, so the ai-worker builds one from features: once per installed Codex version it runs `codex features list` (with `CODEX_HOME` pointed at an empty temporary directory: no login, no model call) and switches off **every** feature it names except a few that only change how the client talks to the API (`enable_request_compression`, `content_item_kinds`, `compaction_image_budget`, `unbounded_connection_retries`, `fast_mode`, `api_key_model_discovery`, `auth_elicitation`, `guardian_approval`, `guardian_reuse_parent_compaction`; exactly these names, a new `guardian_*` feature is switched off like any other). A feature a new Codex version adds is therefore off. A fixed list of tool features (shell and exec, multi-agent, apps and plugins, memories, image generation, browser and computer use, MCP elicitation, hooks, code mode, worktrees, web search, permission requests, network proxy, ...) is switched off in any case, and alone when the listing fails (the process that runs Codex, the ai-worker or `pnpm ai:probe`, then prints a warning once per installation, because features a newer Codex added stay on in that case; concurrent calls share one listing and a failed listing is not cached, so the next call tries again); every name in `disable_features` is added. All of it goes as `-c features.<name>=false` (not `--disable`: with an unknown name it makes the CLI exit outright, whereas `-c` ignores it), followed by `web_search="disabled"`, `include_apply_patch_tool=false`, `tools.view_image=false` and `approval_policy="never"`. These arguments come after all others, so nothing in `ai.yaml` can switch a tool back on; `disable_features` can only add names. The read-only sandbox stays the backstop.
- **`trim_context`**: when true, Codex's built-in agent context is slimmed down. The task's own system prompt is written to `instructions.md` in a temporary directory and used as the base instructions via `-c model_instructions_file="…"`, stdin carries only the user prompt, and the key/values in `config_overrides` are passed as `-c key=value` (turning off the skills list, multi-agent, and the permissions/environment/collaboration notes). Measured on the same scoring prompt: input tokens went from about 16k to about 2.8k. false = the old behaviour (system + user together through stdin, with Codex's default context), still without tools. The group of safety arguments (read-only sandbox, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, an empty temporary directory) is kept in both modes.
- **`config_overrides`**: only context switches set to `false` are passed on: `skills.include_instructions`, `agents.enabled`, and `include_*_instructions` / `include_*_context`. Any other key or value (`mcp_servers.*`, `model_provider*`, `sandbox*`, `approval*`, `shell_environment_policy*`, `profile*`, `features.*`, ...) is ignored; the ai-worker logs a warning at startup and the doctor's `config.guards` lists it. `web_search` is always disabled (except for the task `salary_lookup`, which gets `web_search="live"` with every feature still off; Codex has no domain limit for it), so an entry for it is left out without a warning.
- **`reasoning_effort` / `reasoning_effort_by_task`**: passed as `-c model_reasoning_effort="…"`, default `low`, overridable per task (minimal|low|medium|high|xhigh|max|ultra). If `model` is not set, the CLI's built-in default model is used (gpt-6.1-sol in 0.162.0), **not** the one chosen in `~/.codex/config.toml` (calls carry `--ignore-user-config`).
- **`max_concurrency`**: the maximum number of codex calls at once within one process (default 3); the rest queue. A queued call that is cancelled just leaves the queue, and the timeout counts from process start, not including queue time.
- **`auth_retry_seconds`**: on the first login (auth) error, wait this many seconds (default 5) and retry once; only a second failure counts as an expired login. This is for the collision when several processes share `~/.codex/auth.json` and refresh the token at the same time. 0 = no retry.
- **`min_version`**: the oldest codex-cli this app works with (shipped: `0.122.0`). It is a minimum, not an exact match: 0.122.0 added `codex exec --ignore-user-config` and `--ignore-rules`, which every call passes, while the other pieces we rely on (`--ephemeral`, `model_instructions_file`, `codex features list`) are older, and every newer version is expected to keep them; features a newer version adds are switched off by the features listing (see above), so a newer install needs no re-verification. An older install draws a warning (`pnpm ai:probe`, the ai-worker startup log, the doctor's `config.guards`); calls are not blocked. The former `verified_version` key (an exact version, warned on any difference) is gone; if your own `ai.yaml` still has it, it is ignored without a message.

After upgrading the Codex CLI, go through this checklist: verify the arguments, run one tiny request and check that input tokens are still around 3k, and run `pnpm ai:probe`; raise `min_version` only if a new release of this app tells you to. Reasoning effort (global and per task) can be changed with a dropdown in the codex-cli section of the settings page; the other keys are only edited in YAML and are not shown on the settings page.

### claude-cli

`claude -p` runs with `--tools ""` (no tools at all: no shell, no file access, no web), `--strict-mcp-config` (no MCP server from any settings file), `--safe-mode` (no CLAUDE.md, hooks, plugins or skills), `--no-session-persistence` (nothing written to `~/.claude/projects`) and its own `--system-prompt`, in an empty temporary directory.

The one exception is the task `salary_lookup`: instead of `--tools ""` it gets `--tools "WebSearch,WebFetch"` (no shell, files or MCP), `--allowedTools WebSearch "WebFetch(domain:<host>)" ...` for the hosts in `salary.yaml: lookup.allowed_fetch_domains` (each also with `www.`), `--permission-mode dontAsk`, which denies every tool call that is not pre-approved, and `--setting-sources project`, so permission rules from your own `~/.claude/settings.json` (an "allow WebFetch" rule, say) do not widen the list. That is the CLI's own permission check, not a network boundary, and WebSearch itself is not limited to those domains. It needs `claude` 2.1.296 or newer (verified under `-p`); with an older or unknown version the lookup fails instead of running with other flags.

## What the ai-worker does not take from ai.yaml

`ai.yaml`, `notify.yaml` and `sources.yaml` can be edited from the web UI, while the ai-worker (and the runner) hold your API keys, the Telegram token and the CLI logins. So the processes check these values themselves, whatever the file says. Normal setups never notice: the shipped values pass every check.

- **CLI command**: `providers.claude_cli.command` must be `claude` (looked up on `PATH`) or an absolute path ending in `/claude`, `providers.codex_cli.command` `codex` or an absolute path ending in `/codex` (on Windows also `.exe` / `.cmd`). Relative paths and any other program are never started; the provider counts as unavailable with that reason (`/sources`, `pnpm ai:probe`) and the doctor's `config.guards` fails. A wrapper script must therefore be named `claude` / `codex` (for example in its own directory on `PATH`).
- **Model names** for claude-cli and codex-cli may only contain letters, digits and `._:/[]-` and must not start with `-`, so a model can never be read as a command-line option.
- **codex `config_overrides`**: only the allowlisted keys above, set to `false`.
- **Hosts that receive a credential**: the DeepSeek and MiMo keys (`providers.*.base_url`), the Telegram bot token (`notify.yaml telegram.api_base_url`) and the JSearch, Tavily, Brave, Apify and Monid keys (`sources.yaml` `api_base_url`) are only sent over https to the vendor's own host (`api.deepseek.com`, `api.xiaomimimo.com`, `api.telegram.org`, `jsearch.p.rapidapi.com`, `api.tavily.com`, `api.search.brave.com`, `api.apify.com`, `api.monid.ai`); the Gmail login (`sources.yaml sources.gmail`) only to `imap.gmail.com` on port 993 with `secure: true`. These requests never follow a redirect. Another endpoint is refused: that provider is unavailable, Telegram is not used, that channel's run fails, and nothing is sent. If you really use a proxy or gateway, set `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` in `.env` (it reaches the ai-worker and the containers); every custom host is then used and logged as a warning, and the doctor shows a warning while the variable is set.

## Only one ai-worker

Each ai-worker first takes a Postgres advisory lock (one per database). A second one, for example `pnpm ai-worker` or `pnpm ai-worker --once` in a terminal while the service (launchd or systemd) runs, logs `another ai-worker is running against this database (job-radar ai-worker pid=… host=… since …)` and exits with code 3 before it touches the queue, so requests the first one is running are never queued twice. Without `--once` it first waits `host_worker.already_running_wait_seconds` (default 60), so the service manager does not restart it in a tight loop. Limits are in [deploy.md](deploy.md#only-one-ai-worker). Stop the service first (macOS: `launchctl bootout gui/$(id -u)/io.jobradar.ai-worker`; Linux: `systemctl --user stop job-radar-ai-worker.service`) if you want to run one by hand. Requests left `running` by a crashed worker are only put back into the queue by the worker that holds the lock. If the database restarts, the worker takes the lock again on its next heartbeat; if another worker got it in between, it shuts down.

## How translation works

A long JD is split into chunks by paragraph, one request per chunk, and each chunk is saved into `translation_progress` as soon as it is translated.

- A provider times out or is rate-limited on a chunk: that chunk moves to the next provider, and the remaining chunks of this JD no longer try that provider (so you do not wait out a timeout on every chunk).
- A chunk fails: chunks already translated are kept. A provider-level problem (expired login, all unavailable) stops immediately; if only that chunk's output was unacceptable, the following chunks continue. Retrying ("Continue translation") translates only the missing chunks; the result is written to `translations` only when all are complete. If the JD text changes, the old chunks are discarded.
- The page shows "Translating (2/5)" and the part already translated; on failure it gives the real reason (login expired / timeout / provider error / rate limited / unacceptable output / budget used up / no available provider) and a retry button.

## Troubleshooting

- The AI worker card on `/sources` shows "not responding": macOS: `launchctl print gui/$(id -u)/io.jobradar.ai-worker`; Linux: `systemctl --user status job-radar-ai-worker.service` and `journalctl --user -u job-radar-ai-worker.service`. Then look at `data/logs/ai-worker.err.log` (on macOS, startup failures and crashes are in `~/Library/Logs/job-radar/ai-worker.launchd.log`); if it is not installed, run `scripts/ops/install-ai-worker.sh`.
- The worker is running but scoring fails: most likely the subscription login expired, so log in again in a terminal. The `claude:` / `codex:` lines in the log show which executable it found on the PATH; if it cannot be found, reinstall (the script re-detects the paths).
- To process the queue just once: `pnpm ai-worker --once` (in the project directory). While the service runs this exits with code 3 ("another ai-worker is running"): the service handles the queue anyway.
- A provider shows "must be claude …" / "is not started", or "points to … not …": the guards above refused a changed `command` or `base_url`; `pnpm run doctor` (`config.guards`) says which key.
