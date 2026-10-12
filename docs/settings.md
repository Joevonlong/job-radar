# Settings Page and Manual Actions

`/settings` edits ten config files with forms (`schedule.yaml`, `search.yaml`, `sources.yaml`, `ai.yaml`, `breakdown.yaml`, `salary.yaml`, `notify.yaml`, `ui.yaml`, `insights.yaml`, `resume.yaml`); every other file (`pipeline.yaml`, `models.yaml`, `interests.yaml`, anything added later) and the keys the forms do not cover can be edited as raw text in the "Advanced" tab. Before saving, it validates with the same zod schema the runner uses, and writes back to the user config directory (default `data/config/`; each tab's description shows the actual path; the first time you save a file that only exists in the shipped defaults, it is generated from the default file as a base, see [`configuration.md`](configuration.md)), preserving YAML comments. Once the runner hot-reloads, the save bar shows "runner loaded" (when the runner has no heartbeat this changes to "runner is not running", so it never contradicts the sidebar's OFFLINE). Keys that are not on the page (for example `test_channel`, `manual_triggers`) stay in the YAML for you to edit.

## The tab bar and the four sections of the AI tab

Tab bar: Schedule · Search · Sources · AI · Breakdown · Salary · Notifications · Interface, and after a divider "Manual actions" (`/settings?tab=actions`). Manual actions (run a cycle now, re-score stale scores, score unscored jobs, Telegram test, recent requests) live only in that tab and not at the bottom of the others; old links such as `/settings#rescore` become `/settings?tab=actions#rescore`. Below the manual actions, the "First-run setup" card reopens the setup wizard (`/setup`) in review mode: no redirect, every save applies at once ([setup.md](setup.md)).

The AI tab has four numbered, bordered sections (purely a UI grouping; the format of `ai.yaml` is unchanged):

1. **Providers**: one card per vendor (Anthropic, OpenAI, DeepSeek, Xiaomi MiMo). One row per access method: Anthropic has two rows, "subscription CLI" (`claude-cli`) and "API" (`anthropic`); OpenAI is "subscription CLI" (`codex-cli`); DeepSeek / MiMo are "API". Each row has its own enable switch (both rows can be on, and routing uses them in order as fallbacks), an availability state (available / login failed / key configured / no key configured / cooling down ...; the web process cannot see the CLIs on the host, so a CLI shows "available" until a call reports a login error), the model, the strong model, and the daily request limit; timeout, command, endpoint and the like are tucked into "More settings". An enabled row has a green bar on its left, and the yellow tag at the top right of the card says "which method and which model is in use now". The bottom of the card has a collapsible "Model catalog".
2. **Routing and task assignment**: the global order (nodes are shown as "vendor · method", with the internal order of the API layer next to it); below it one row per task (scoring, signal extraction, translation, summary, suggestions, breakdown, salary lookup): unchanged = "follow global"; to customize, give it its own order and pick a model for each node, and "Switch back to global" clears it in one click.
3. **Limits and budget**: items / time per cycle, cooldown, the usage cap of the subscription CLIs (calls per cycle and per rolling window; it counts only Job Radar's own calls, see [ai-providers.md](ai-providers.md)), monthly API budget, timeout, max output tokens, the score threshold for automatic translation.
4. **Scoring parameters**: JD truncation, concurrency, batching, German-level penalty.

## AI tab: scoring criteria

The scoring block of the AI tab has **Scoring criteria** (`ai.yaml: scoring.criteria`): *priorities* (what matters most),
*dealbreakers* (situations you will not accept: such a job lands in the 0-29 band) and *nice to have* (small pluses), one
sentence each, in any language, at most 10 per list and 300 characters each. The score stays one 0-100 number; the
criteria go into a fixed section of the scoring prompt, like your other preferences (they leave the machine with the job
description). Criteria are part of the prompt version (`score-v1+c<hash>`): when you change them, the tab says how many
current scores will be re-scored before you save; after saving those scores are marked stale and scored again over the
next runs. Clearing the criteria returns to `score-v1`. The language the AI writes in is set in `language.yaml`
([languages.md](languages.md)) and does not re-score anything.

A dealbreaker you can write as a rule (a required language level above yours, a phrase in the posting) is cheaper as a
**deal-breaker** on My profile → What I want: it vetoes the job in the hard filter, before any AI call, and costs no
scoring call. See [deal-breakers.md](deal-breakers.md).

## AI tab: reason sources

**Reason sources** (`ai.yaml: scoring.evidence`, off by default) marks every fit reason and gap on the job page as
**JD** (with the posting's own words and a jump to them), **Inferred** or **Not stated**. Each scoring call then answers a
little more (more output tokens), and the quote limit (`quote_max_chars`, default 150) caps the quotes. Neither switch
re-scores anything; old scores keep their reasons without sources. See [score-evidence.md](score-evidence.md).

## AI tab: dropdown selection

- **Provider order** (`order`, `api_order`, and each task's `tasks.<task>.order`) is an ordered list: move up / move down / remove, and use the "Add" dropdown to put one back. The only selectable values are the providers defined in `config/ai-options.ts`, and the `ai.yaml` schema takes them from there too, so the two cannot disagree.
- **Unavailable labels**: in the order list and the Add dropdown, a provider that cannot be used is followed by the reason: not configured (an API without a key, or the host reports the CLI cannot be found), disabled, login failed (the latest call reported a login error and none has succeeded since), cooling down, daily limit reached. The data is the same as the "AI provider health" on `/sources`.
- **Models always sit under a provider**: the model catalog is `config/models.yaml` (which models exist, prices, deprecation flags), and the settings page only selects, never edits. Each provider (one row inside a vendor card) shows its current model; "Model" (and for claude-cli / anthropic also "Strong model") is a dropdown that lists only the non-deprecated models in **this provider's** catalog, with option text "display name · id", and for APIs also "· $input / $output" (per million tokens). If the current value is deprecated: an extra "(deprecated)" option is added and selected, and saving is allowed; if the current value is not in the catalog: "(not in model catalog)" is shown, and saving reports an error under the field and leaves the file unchanged. The collapsible "Model catalog" at the bottom of a vendor card is a read-only table (id / display name / price / codex reasoning effort / flags / notes, with a link to the official model list when `docs_url` is set). There is **no** "available models" tag box and no "model prices" section. To add a new model: `models.yaml` is a shipped file, so copy `config/models.yaml` to `data/config/models.yaml` and edit the copy (the file starts with 5 steps). Your copy then replaces the shipped list entirely, so later updates to the shipped models will not reach it until you copy again; it takes effect in about 5 seconds, and refreshing this page shows it in the dropdowns; see the "new model checklist" in `ai-providers.md`.
- **Order lists**: each item is followed by small grey text showing the model it currently uses (`codex-cli · gpt-6.1-sol` / `· CLI default`, `api → deepseek, anthropic, mimo`, and in `api_order` each one's default model), updating live with the draft.
- **Task assignment** (section 2): one row per task, empty = follow the global order. Each row is "index · provider · model dropdown · move up / move down / remove": the first item of the model dropdown is "default · <the model chosen in that provider's section>" (not specified), followed by the models in that provider's catalog; the `api` entry has no dropdown (each API provider uses its own default model). First "Add..." a provider, then pick its model on the same row; removing a provider removes its model with it. Saved as `tasks.<task>: {order: [...], models: {provider: model}}`.
- **codex-cli**: the empty option of the model dropdown is "CLI default (<display name of the catalog entry marked cli_default>)" (no `model` key is written); reasoning effort is a dropdown listing only the efforts supported by the currently selected codex model (`reasoning_efforts` in the catalog, unset = all); when the current value is not supported there is an extra "(not supported by this model)" option, and saving reports an error; the per-task reasoning effort has an extra "follow default".
- **Catalog unreadable** (`models.yaml` missing, bad YAML, fails the schema): a red box at the top of the AI tab, "<actual models.yaml path> could not be read: ...", the model dropdowns show only the current value, clicking save returns "Model catalog unreadable, fix models.yaml first", and the other tabs are unaffected.
- On save, the server validates again with the same schema and checks against the catalog: a model not in the catalog, a codex reasoning effort the model does not support, a model chosen for a provider that is not in the task's own order, or an unknown provider in an order list, each reports an error under the field and leaves the file unchanged. Selecting a deprecated model only marks it and does not block saving.

`ai.yaml` excerpt:

```yaml
providers:
  claude_cli:
    model: claude-sonnet-5-5       # must be a model under claude-cli in models.yaml
    strong_model: claude-sonnet-5-5
  codex_cli:
                                   # without model the CLI default is used (the one marked cli_default in models.yaml)
    reasoning_effort: low          # must be in the selected model's reasoning_efforts (unset = unrestricted)
    reasoning_effort_by_task: {}   # e.g. { translate: medium }
  deepseek:
    model: deepseek-flash          # a model under deepseek in models.yaml (with prices)
tasks:
  translate:
    order: [codex-cli, claude-cli, api]
    models: {claude-cli: claude-sonnet-5-5}   # when this task reaches claude-cli it uses Sonnet; you can only specify providers listed directly in this task's order
```

`models.yaml` excerpt (the catalog):

```yaml
providers:
  deepseek:
    label: DeepSeek API
    models:
      - id: deepseek-flash
        label: DeepSeek V4.1 Flash
        price: { input_per_mtok: 0.3, output_per_mtok: 1.2 }   # required for API providers, not allowed for subscription CLIs
```

## Interface tab: languages

The "Interface" tab starts with the **Languages** block, which edits `language.yaml`: the default interface language
(for browsers that never picked one), the language the AI writes in and the extra languages of the one-line summary,
the language job ads are translated into, and the Telegram and command-line languages ("Same as the interface
default" leaves them `null`). Interface languages are offered by their own names; the AI language and the translation
target take any language code (`en`, `zh`, `de`, `pt-BR`), and a wrong one is refused with a field error. The runner
and the ai-worker reload the file (the save bar shows when the runner has it); the web app reads it on every page.
What each key does: [languages.md](languages.md).

## Interface tab: scales and cycle counts of the graphic components

The "Interface" tab edits `data/config/ui.yaml`. These values only affect display (the salary axis, freshness bar, trend lines, health squares, ticker), not collection or scoring. The web app re-reads them every time a page opens; the runner does not use them, so the save bar only says "read directly by the web app, effective on refresh" and has no runner-loaded state.

| Key | Default | Meaning | Constraint |
|---|---|---|---|
| `salary_axis.min_k` | 40 | Left end of the salary axis, thousand EUR / year | integer >= 0 |
| `salary_axis.max_k` | 200 | Right end of the salary axis, thousand EUR / year | integer, greater than `min_k` |
| `salary_axis.tick_step_k` | 20 | Tick interval, thousand EUR | positive integer, smaller than the whole axis (`max_k - min_k`) |
| `salary_stats.min_sample` | 5 | Number of jobs with a stated salary this month needed before the detail page draws the salary median line and "higher than X% of disclosed jobs"; with fewer, it is not drawn | positive integer, at most 1000 |
| `freshness.decay_hours` | 72 | After how many hours since first seen the freshness bar shrinks to its shortest (the shortest is 6% of the full bar, it never disappears) | positive integer |
| `freshness.warn_hours` | 24 | Past how many hours the freshness bar turns yellow with a diagonal-stripe texture | positive integer, smaller than `decay_hours` |
| `trend_cycles` | 7 | How many recent cycles the trend line of the summary block uses | 2 - 60 |
| `health_cycles` | 14 | How many recent cycles the health squares of each channel on the sources page use; missing cycles are drawn as dashed empty cells | 1 - 60 |
| `ticker_max_items` | 8 | How many items the top ticker scrolls at most | 1 - 50 |

- The red line (floor) in the salary axis comes from `data/profile/preferences.yaml: salary_floor_year`, and the red triangle (the push line of the score battery cells) from `notify.yaml: push_min_score`; neither is in `ui.yaml`, and changing them affects the graphics too.
- When a stated range goes beyond the axis, the colour block is clipped at the two ends (the axis does not auto-scale): to see higher salaries, raise `max_k`.
- On save the same schema validates again; errors are written under the relevant field (max must exceed min, the tick interval must be smaller than the whole axis, the yellow line must be smaller than the decay hours).
- Usage and examples of the graphic components are on the development page `/dev/viz` (404 in production).
- Today page and Jobs page: the trend in the summary block takes the most recent `trend_cycles` cycles, and the ticker shows at most `ticker_max_items` items; the freshness bar in tables uses `freshness`, and the mini salary axis uses `salary_axis`; the push line of the score battery cells is `notify.yaml: push_min_score`, and the "≥ N" in the third block of the summary is that too.
- The "skill overlap" in the jobs table compares the job's skills (`jobs.skills`, the names from `pipeline.yaml: skills`) against the skills in `me.yaml`, ignoring case, spaces, hyphens and singular/plural; other spellings of the same skill go in `pipeline.yaml: skills[].aliases` (for example `k8s`, `Large Language Models`), and only affect this column, not tagging. A job with no skills listed shows "—", not 0/0.
- "Higher than N% of disclosed jobs": compared against jobs with a stated salary this month (by first-seen time, in the `schedule.yaml` timezone), by range midpoint (one-sided figures use that end), excluding hard-filtered ones, those pending review and those whose salary may be for another region; with fewer than 2 samples no percentile is shown.

```yaml
salary_axis: { min_k: 40, max_k: 200, tick_step_k: 20 }
salary_stats: { min_sample: 5 }
freshness: { decay_hours: 72, warn_hours: 24 }
trend_cycles: 7
health_cycles: 14
ticker_max_items: 8
```

## Notifications tab: Telegram

At the top of the Notifications tab a Telegram block shows whether the bot is set up: "Connected", "Not connected",
"Incomplete" (only one of `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` is set) or "Invalid values"; which of the three
`TELEGRAM_*` variables are set (names only, never a value); whether the push is on; and the last test message. When it is
connected there is a test button and the command to change it; otherwise a short guide with the command to run on the
host, `pnpm run setup --step telegram`, with a copy button. The page cannot enter or change the token: see
[telegram.md](telegram.md#1-set-it-up-with-one-command). The setup wizard's Telegram step shows the same block.

## Workflow tab

Hide the application statuses you do not use, set the two reminder timeouts, hide unused categories in the list filters, and edit `resume.yaml` (the resume tool). **Statuses are fixed**: none can be added or renamed, and "New" and "Ignored" cannot be hidden. Hiding only affects display.

- **Status table**: one row per status (name, board column, current application count, a "Show" switch, timeout days). Only "Interested" and "Applied" have a timeout (`notify.yaml: reminders.interested_days / applied_days`, moved here from the Notifications tab). One save validates `ui.yaml` and `notify.yaml` first, then writes both; if the second write fails it says which file is still old.
- **Effect of hiding**: a hidden status without cards loses its board column; one that still has cards becomes a folded narrow column ("In interviews, hidden, 2": open it to see the cards; nothing can be dropped into it) and the header says how many cards sit in hidden statuses. Status menus (card menu, drawer, detail page and its "Mark applied" button), the `/jobs` filter, the `s` shortcut, Telegram buttons and the stats funnel (when empty) stop listing it; a card's own current status is still listed, marked "(hidden)". A link or saved view that already selects a hidden value keeps working. The server still accepts moves to hidden statuses (old pages, old Telegram messages).
- **Categories**: workplace (on-site / hybrid / remote) and contract type can be hidden in the `/jobs` filter; "unknown" cannot.
- Keys in `ui.yaml`: `applications.hidden_statuses`, `filters.hidden_workplaces`, `filters.hidden_contracts` (all default `[]`). `ui.yaml` moved to `config_version: 2`; `pnpm config:migrate --write` inserts the `applications`, `filters` and `config_editor` blocks with comments, and a file not yet migrated runs unchanged in memory.

## Advanced tab

`/settings?tab=advanced`: every config file as raw text (not the profile files). The left column groups files into "User config" and "Product defaults" (models, pipeline) and shows each file's source (user directory / default / overrides default), whether it is valid (with the first problem) and whether its version is behind. `?tab=advanced&file=pipeline` opens a file directly (`file` is the file name without `.yaml`).

- **Editor**: line-numbered monospace textarea. Tab indents two spaces (Shift+Tab unindents; Esc then Tab leaves the box), Cmd/Ctrl+S opens "Preview and save", lines with problems are red.
- **Live validation** (0.4 s after typing, on the server): YAML syntax, `config_version` (must equal the code's), zod schema, cross-file checks (`ai.yaml` models against `models.yaml`, and the reverse when saving `models.yaml`). Each problem shows path, reason and line:col; click to jump. Save is disabled while there are problems.
- **Preview**: diff against the saved version or the product default, with the changed key paths on top.
- **Save**: re-validated on the server, then written exactly as typed (comments and layout intact). The old text is first backed up to `<user dir>/.backup/editor/<time>/<file>` (newest `ui.yaml: config_editor.backups_keep` kept, default 20; text at most `config_editor.max_bytes`, default 256 KiB). The write is atomic; the runner picks it up by hot reload.
- **No overwriting**: the file's hash and source layer are recorded when the editor opens. If either changed at save time (settings form, source list, another tab, a hand edit) the save is refused with "When opened -> now" and two buttons: "Load latest file" (drop your edits) or "Copy my text". There is no auto-merge.
- **Product default files**: a yellow note says saving creates a whole-file override in the user directory and later product updates of that file will no longer apply; the first save needs a confirmation. "Restore default" backs up and removes the override. For user files it replaces the content with the default file's (after a backup, with the diff shown).
- **Secrets**: proxy credentials in `sources.yaml: jobspy.proxies` show as `***:***@` in the editor and diffs and are put back at the same position on save; changing, adding or removing a proxy is refused. Keep secrets in `.env`.
- **Protected keys**: commands, API hosts and credential paths (list in [configuration.md](configuration.md#protected-keys-edited-by-hand-only)) are listed above the text; changing one shows a "locked key" problem on its line and Save stays off. The forms on the other tabs show these fields read-only. Edit them in the file by hand.
- **Repair**: when a file is invalid, other tabs link to "Fix it in the advanced editor". The editor needs no readable config: a broken `ui.yaml` falls back to default limits.

## Breakdown tab: job breakdown

The "Breakdown" tab (after "AI") edits `data/config/breakdown.yaml`: the switch and mode (`enabled`, `mode`: manual / automatic), the threshold and per-cycle cap for automatic breakdown (`auto.min_rank`, `auto.per_cycle_limit`, effective only when the mode is "automatic"), and the request (`jd_max_chars`, `timeout_seconds`, the latter labelled in "seconds"). `jd_head_share` is not in the form; edit the YAML directly. Saving and the "runner loaded" confirmation work like the other tabs (the runner and ai-worker both watch this file). It is off by default; which AI to use is set in the task overrides on the "AI" tab (the task "breakdown", and for codex also "Reasoning effort: breakdown"). See [`breakdown.md`](breakdown.md) for details.

AI trap detection has no tab of its own: its switch, mode and thresholds are in `traps.yaml` (see [ai-traps.md](ai-traps.md)); which AI checks is set under task overrides on the "AI" tab (task "AI trap check", for codex also "Reasoning effort: AI trap check").

## Salary tab: salary level and salary lookup

The "Salary" tab (after "Breakdown") edits `data/config/salary.yaml`: the benchmark (`benchmark.enabled`,
`window_days`, `min_sample`, `include_ai_lookups`) and the salary lookup (`lookup.enabled`, `ttl_days`, `max_per_day`,
`timeout_seconds`). The role families, the salary-site links and the lookup's domain list and plausible range are edited
in the YAML (Advanced tab). The lookup is off by default; which AI runs it is the task "Salary lookup" on the AI tab
(default claude-cli, then the Anthropic API; only providers that can search the web are used, and codex-cli, if you add
it, searches without a domain limit). See [salary.md](salary.md).

## Manual triggers and tests

Every button only leaves a request in `control_requests`, which the runner (in the container) or ai-worker (on the host) picks up and executes; the page polls that request every 2 seconds and shows the result right under the button. While a request is unfinished the button is greyed out; a request of the same kind for the same target that has not finished is simply reused, and after it finishes, clicking again within `schedule.yaml: manual_triggers.min_interval_seconds` (default 30 seconds) is rejected with a hint of how many seconds remain. Each request creation writes one `manual request queued` line in the web log. If there is still no result after 10 minutes, the button shows a hint that the runner / ai-worker may not be running.

| Button | Location | Request | Executed by | What it does |
|---|---|---|---|---|
| Run a cycle now | `/settings?tab=actions` Manual actions | `run_cycle` | runner | One manual cycle; you can tick only some channels |
| Collect now | `/sources` channel card | `run_cycle` (with only this channel) | runner | Runs one full collection of this channel (writes jobs, counts against the budget). If a cycle is already queued or running it is reused; the runner's concurrency lock stays as is: while another cycle is running, this one is recorded as "another cycle is running" |
| Test | `/sources` channel card | `test_channel` | runner | Runs only the first query (a whole-board scan for ATS kinds), takes at most `sources.yaml: test_channel.max_results` items (default 5), parses them in memory, and shows the number fetched / parsed and the first few titles; it does **not** write jobs, raw text, run records, usage or circuit-breaker state. It does not test while a cycle is running, or when the channel is disabled, not configured, or its monthly budget is used up. Channels whose kind is in `test_channel.excluded_kinds` (default `paid`, `session`) have no test button: paid channels bill per item and the LinkedIn session has a daily page limit, so use "Collect now". Exceeding `timeout_seconds` (default 120) is recorded as `timeout`. Discovery channels (tavily, brave) do not fetch jobs: the test sends at most `test_channel.max_queries` (default 1) searches and on success shows "fetched 0 items" (the API works), the discovered boards are not saved, and the quota used is not counted in this month's usage |
| Test | `/sources` AI provider health | `test_ai` | ai-worker (the runner when `execution: container`) | The same tiny request as `pnpm ai:probe`, going through normal routing but trying only this one provider: disabled, cooling down, daily limit reached, missing key, or a used-up monthly API budget are all rejected directly. It counts toward the day's request count and the health record, and usage is recorded in `ai_usage` (task name `probe`, shown as "test" in the AI usage on `/sources`). The result shows the actual model, duration and tokens |
| Send Telegram test message | `/settings?tab=actions` Manual actions | `test_telegram` | runner | After clicking you must click "Send" again to confirm; it sends even if `notify.yaml: telegram.enabled` is still false, to confirm the bot token and chat id |

On failure the button shows the reason and an error code (for example `network`, `blocked`, `auth`), not the raw error text; for details see the runner / ai-worker logs (`channel test failed`, `ai provider test failed`, `telegram test message failed`).

### After deploying

New request types require both the runner and ai-worker to run the new code: the database migration (`0018`) is run automatically by the runner at startup; step 10 of `scripts/ops/deploy.sh` restarts ai-worker. If you did not use `deploy.sh` (or passed `--no-ai-worker`), restart it once by hand (`launchctl kickstart -k gui/$(id -u)/io.jobradar.ai-worker`, or rerun `scripts/ops/install-ai-worker.sh`), otherwise AI tests stay queued. The new `tasks.<task>.models` in `ai.yaml` updates along with the code. When upgrading to the version with the model catalog: first upgrade the code (`models.yaml` is new, `ai.yaml` only changes comments, old code is unaffected), then in the project directory run `pnpm models:migrate --dry-run`, `pnpm models:migrate`, `pnpm config:check`; only after that can you write into `tasks.*.models`. When old code meets a new file, or new code meets an old file, hot reload ignores the invalid config and keeps the previous one.

### Tuning

```yaml
# sources.yaml
test_channel:
  max_results: 5
  max_queries: 1             # how many searches at most for discovery channels (tavily, brave)
  timeout_seconds: 120
  excluded_kinds: [paid, session]

# schedule.yaml
manual_triggers:
  min_interval_seconds: 30   # 0 = unlimited
```

## Save bar, time chips and leave warning

- The tabs sit at the top of the page (segmented), and the manual actions card is below the config form.
- The save bar floats at the bottom of the viewport on `/settings`, `/me` and `/interests` (on phones too); when there are no changes, "Save" and "Revert" are greyed out.
- The grey chip next to a cron input is a read-only explanation ("Weekdays 07:00"); the input itself remains the editable original text. The timeline also draws disabled cycles: dashed outline, grey text with strikethrough.
- The units in number inputs (hours, milliseconds, k€ ...) come from the key name and are written in the field, so you do not need to read the label.
- With unsaved changes, clicking a sidebar link or a page in the command palette pops up "Stay / Discard changes"; refreshing or closing the tab uses the browser's own prompt. The browser's back button is not intercepted.
- On save only the parts you changed are touched: `{ a: 1 }` / `[a, b]` styles already in the file stay as they are, and empty lists produced by schema defaults (`exclude: []`) are not written into the file.
