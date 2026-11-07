# Where the configuration lives: shipped defaults + user config directory

All Job Radar settings are YAML, in two layers:

| Layer | Location (environment variable, default) | Who edits it | In git |
|---|---|---|---|
| Shipped defaults | `JOB_RADAR_DEFAULTS_DIR`, default `config/` | Changes only with product versions | Yes (ships with the product) |
| User config | `JOB_RADAR_CONFIG_DIR`, default `data/config/` | You, the web app (/settings, /interests, /sources/registry), `pnpm config:*` | No (`data/` is ignored) |
| Profile | `JOB_RADAR_PROFILE_DIR`, default `data/profile/` | You, the web app /me | No |

Relative paths are resolved against the project directory (not the current directory). In Docker, the shipped defaults are part of the web and runner images: the Dockerfile copies `config/` to `/app/config` (owned by root, readable by everyone, writable by no one) and sets `JOB_RADAR_DEFAULTS_DIR=/app/config`; nothing is mounted there. `scripts/ops/deploy.sh` builds the images from a `git archive` of the commit it deploys, so the defaults in the containers are exactly the committed `config/`, and a change to `config/` reaches them only with a deploy (a plain `git pull` changes nothing in the running containers). The user config and the profile are bind mounts (`compose.yaml`: web `./data/config:/app/data/config`, runner the same read-only). The host ai-worker reads `config/` from the checkout; `scripts/ops/install-ai-worker.sh` writes all three directories explicitly into its launchd plist or systemd unit.

A file in `data/config/` wins over the default with the same name, so `git pull` never touches your settings, and almost
everything can also be changed on the Settings page. `pnpm config:example` applies a ready-made setup as a head start.

Secrets (API keys, the Telegram token, the Gmail app password, the web password hash) go only in `.env`, never in the
YAML files. The one exception to watch: `jobspy.proxies` in `sources.yaml` can contain proxy credentials
(`user:password@host`), and every backup's config archive includes that file, so keep backup archives private. Which
source needs which key: [installation.md](installation.md#2-optional-create-env).

## Which copy is read

- The value of a file is the **shipped file with your file laid over it**, key by key. Your file holds only what differs: a key you do not write follows the product, including its later updates. A file you do not have at all is the shipped file. See [Your file is an overlay](#your-file-is-an-overlay).
- Saving in the web app always writes to the user directory, and only what changes: a changed value goes in, a value set back to what the shipped file holds comes out, and comments on the rest stay. A file that does not exist yet starts as a short stub. The defaults directory is never written. A value the schema only fills in is not written either, so a later change of that default still reaches you.
- Hot reload watches both layers: a user file appearing, being deleted (falling back to the default), or a default file changing (for every key your file does not hold) all take effect within about 5 seconds. In the containers the defaults are in the image and only change with a new image (a deploy); outside Docker (`pnpm dev`, the host ai-worker) a changed file in `config/` is picked up like this. The runner and the ai-worker watch every config file, `me.yaml` and `preferences.yaml` included, and also re-read them at the start of each cycle and each request, so a change (for example the market saved in the setup wizard or on `/me`) applies to the next cycle even when it starts right away, without a restart.
- The web app and the MCP server have no watcher, so they check the files themselves: a read of a config more than 5 seconds after the last check first re-reads every config it has loaded, so a file you edit by hand (or that another process changed) shows up on the next page load without a restart. An invalid file is ignored (the last valid values stay) and reported once in the log. `JOB_RADAR_CONFIG_POLL_MS` (default `5000`, in milliseconds; set it in the environment of the process) is this interval and also the watchers' polling interval; `0` turns off this check and the watchers' polling (a watcher still reacts to file events).
- `pnpm config:check` prints which layer each file is read from: `(user changes on the shipped file)`, `(user, whole file)` for a file not converted yet, `(default)`.

## Your file is an overlay

A file in `data/config/` holds only what differs from the shipped file:

```yaml
config_version: 3     # the shipped file's version: this is what makes the file an overlay
push_min_score: 64    # replaces the shipped value
quiet_hours:
  start: "23:00"      # maps merge key by key: quiet_hours.end still comes from the shipped file
targets: [Data Engineer]   # a list replaces the shipped list as a whole
backup:
  max_age_hours: !unset    # removes the shipped key: the schema's default answers, or the file is invalid if the key is required
```

- **Maps** merge key by key, **lists** are one value, and some maps whose keys are entries of their own (for example the
  sources of a channel list) replace an entry as a whole. Migrations carry both layers forward.
- **`!unset`** only means something in an overlay. It stands on a key of a mapping with nothing after it; never in a list,
  on `config_version`, or in a file of the older format, where it is an error on its line that says which version to write.
- **A file without `config_version`, or with a lower one, is a whole file**: it is the older format, read by itself, and the
  shipped file does not fill it in. Saving it keeps it whole (at the last version before the overlay format); a form save, the
  advanced editor and the source import never change a file's format. The deploy's write step converts it. A whole file
  without a version gets a warning in the log, once, and in `pnpm config:check` and the doctor.
- **New files**: `pnpm config:init`, the wizard and a first save write a stub with the version and a comment. While any file
  in the directory is still whole, a conversion is pending, so a new file is written whole too and converted with the others.
- **The conversion** (`pnpm config:migrate --convert-overlays`, a preview; a deploy runs it with `--write`) keeps a key when it
  differs from the shipped file. The originals go to `data/config/.backup/<time>/`, and the keys dropped and kept, never
  their values, go to `data/config/conversion-<time>.json`. `config:check --effective` gives the same hashes before and after.

Two limits you accept with the conversion:

1. **A pin equal to the shipped value is dropped.** A key you wrote on purpose that equals today's shipped value leaves
   your file and follows the product from then on. The record of the conversion lists it: to keep it pinned, write it back.
2. **An old default stays pinned.** A value that came from an earlier shipped default and differs from today's looks like
   your own choice, so it stays. Remove it from your file to follow the product again.

Conversion removes the comments on dropped keys: after that they exist only in `data/config/.backup/<time>/`
(`schedule.yaml config_writes.backups_keep` keeps the latest 5 by default) and in earlier config archives (`….config.tgz`),
and a comment can end up sitting above a neighbouring key. An entry map you emptied, such as `glossary: {}` under
`translation` in `ai.yaml`, becomes one `!unset` per shipped term, so terms shipped later will appear.

Back to whole files for older code: `pnpm config:migrate --to-full --write`, see
[Rollback](deploy.md#5-rollback). Downgrading and upgrading again converts once more: a value that the older version's
shipped file held and that you kept is compared with the new shipped file, so limit 1 applies again. Values you saved while
on the older version stay yours. Keeping the files of a backup instead, for example if a conversion was wrong:
`pnpm config:migrate --restore <time> --accept-loss`; saves made since then are lost, what stood there is archived first.

Restart `pnpm mcp:serve`, `pnpm dev` and other processes you started by hand after a deploy that converts: they would run the
older code, which refuses a file of the overlay format.

## What your files change

`pnpm config:check` prints one line per overlay file with the number of keys it overrides and unsets, for example
`data/config/schedule.yaml  3 overrides, 1 unset`. A healthy install after the conversion has small numbers: only what you changed.
Two kinds of line need a look, neither is a failure:

- **a pin equal to the shipped value**: you wrote a key whose value is the shipped one. It stays (a save never removes it) but stops
  following product updates. Remove the line to follow the product, or keep it on purpose;
- **an `!unset` of a key the shipped file does not have**: the line does nothing (a typo, or a product update removed the key).
  Remove it. The doctor only mentions it.

`pnpm config:check --overrides` lists every key of every overlay file (`--json` for a machine-readable list). A protected key
(the program to run, an API host, a credential file; see the settings guide) is listed without its value, and other
values show only if they are numbers, booleans or short plain strings (never URLs or token-like text); a list or a map shows its size. The doctor's `config.layers` shows the same totals in its summary line and
lists pins and unsets that do nothing as information; it never warns about them. These commands only read.

For maintainers, `pnpm release:changed-defaults <from-ref> <to-ref>` lists the shipped defaults that differ between two git
refs (the values every install without an override receives), with the protected keys in a section of their own and no values.

## Two kinds of files

| Kind | Files | First-time setup | On product upgrade |
|---|---|---|---|
| `user` | schedule, search, sources, ai, notify, interests, ui, breakdown, resume, insights, language, setup, salary ([salary.md](salary.md)), mcp ([mcp.md](mcp.md)), writer ([application-writer.md](application-writer.md)) | `pnpm config:init` (the deploy runs it) or a save creates your file in the user directory; it holds only what you change, and the rest follows the shipped file | Your files are never changed automatically; format changes are carried over by migrations (`config_version`) |
| `shipped` | models (model catalog and prices), pipeline (parsing rules, city and skill tables), pipeline-board (board layout and card display), job-search (job query parsing and matching settings), job-archive (seen-again rules), signal-presets (the presets of the "Add category" dialog on `/interests`, see [signals.md](signals.md#add-your-own-interest-point)) | Not copied; always read from the defaults directory | Follows product updates |

Nothing writes these files at start-up: web and runner only log how many user files are missing and read the
defaults instead. A `user` file that a product upgrade introduces is created by the next deploy (step 11) or by
`pnpm config:init`. `setup.yaml` and `language.yaml` belong to the setup wizard and are not created that way (see below).

To change a `shipped` file, write only the keys you want to change into a file of that name in the user directory, with the file's `config_version` (the advanced editor opens it that way). Everything else keeps following the product. To follow the product completely again, delete your file. `models.yaml` works differently: your `data/config/models.yaml` is laid over the shipped one model by model (see [AI providers](ai-providers.md#checklist-for-a-new-model-release)), so it never hides product updates of the models you do not list.

Market packs (`config/packs/<id>/`: countries, cities, local-language rules) are `shipped` the same way: a copy in `data/config/packs/<id>/` replaces the shipped pack as a whole. See [market-packs.md](market-packs.md).

The profile files `me.yaml`, `preferences.yaml` and `stories.yaml` (your experience library, see
[application-writer.md](application-writer.md)) live in `data/profile/` and are edited on `/me`, where stories can also be extracted from a text or résumé (`writer.yaml: import`). The optional
`deal_breakers` list of `preferences.yaml` (rules that veto a job before any AI call) is described in
[deal-breakers.md](deal-breakers.md); its limits are in `pipeline.yaml: filter.deal_breakers`.
Runtime profile readers can use `config/profile.example/` without creating a file. Raw-file checks, the doctor and
watcher still distinguish a missing user profile from a saved one; templates do not become a default config layer.

## Seen again (`job-archive.yaml`)

`config/job-archive.yaml` is a shipped file. To change a key, write it into `data/config/job-archive.yaml` with the
shipped file's `config_version`; the rest follows the shipped file. Remove the key to follow it again. Both keys are required, and unknown keys or
out-of-range values are rejected.

| Key | Shipped value | Meaning |
|---|---|---|
| `relist.min_gap_days` | `14` | Integer 0–3650: minimum gap between source listings, with an observed absence in between. `0` disables recording relists but still maintains last listed. |
| `relist.badge_days` | `14` | Integer 1–365: window for the Seen again tag, `/jobs?relisted=true` and Today's note. |

These settings do not affect scoring/filter fingerprints or cause new AI work. If you roll back to code that does not
maintain last listed and later upgrade again, temporarily set `relist.min_gap_days: 0` for one collection cycle to
refresh the baseline, then restore your chosen value. Old code ignores this file and the added database columns;
keep the columns when rolling back.

The same applies when maintenance has not run for `relist.min_gap_days` days or more while collection kept running:
the first maintenance afterwards can record a batch of false relists. Before it runs, set `relist.min_gap_days: 0` for
one cycle, then restore your chosen value. `pnpm reprocess` replays stored postings and never records a relist.

## Application board (`pipeline-board.yaml`)

This shipped file has `config_version: 1`. Existing installations read it from the defaults directory without a migration.
To customise it, write the keys you change into a file of that name in the user config directory ([overlay](#your-file-is-an-overlay)); the rest follows shipped updates.
All six keys are required. Unknown keys, invalid densities and values outside the ranges below are rejected with the field path.

| Key | Shipped value | Allowed | Purpose |
|---|---|---|---|
| `density.default` | `compact` | `compact`, `comfortable` | Default card density |
| `density.remember_days` | `365` | Integer 1–3650 | Days to remember the density choice |
| `compact.title_lines` | `2` | Integer 1–4 | Maximum compact title lines |
| `compact.next_action_lines` | `1` | Integer 1–3 | Maximum compact next-action lines |
| `layout.column_min_width_rem` | `14` | 10–24 | Minimum desktop column width, in rem |
| `layout.board_min_height_rem` | `24` | 12–60 | Minimum board height on short screens, in rem |

All keys apply to the board. Compact cards clamp the title and next action to the configured line counts without reducing font sizes. The toolbar switches density and stores `jr_board_density` in this browser for `density.remember_days` days. Missing or invalid cookies use `density.default`; the server renders the chosen density on the first response.

## Job search settings (`job-search.yaml`)

This shipped file configures the job search parser separately from collection criteria in `search.yaml`.
It controls /jobs, Today saved-view searches, view trends, quick-open search and MCP search_jobs.
All keys are required and unknown keys are rejected. Defaults live in the YAML only.

- `query`: input length (`max_chars`, integer 10–200; 200 is also the limit of MCP `query` and a saved view's `q`),
  distinct term limit (`max_terms`, integer 1–50), minimum standalone CJK fragment length (`cjk_min_chars`, integer 1–10),
  and `all_scope_timeout_ms` (integer 1–120000): the time limit of each list or count query that also searches
  descriptions (`searchIn=all`). If any query times out, /jobs shows "Full-text search timed out" above the list,
  keeps any successful results, and displays unavailable counts as “—”. MCP `search_jobs` returns a `search_timeout` error.
- `matching.prefix_min_chars`: minimum word length for prefix matching, integer 1–20.
- `ranking`: field `weights` (`title`, `company`, `location`, `country`, `description`, `translation`, each 0–100)
  and `prefix_factor` (0–1). Each term contributes only its highest matching field weight; prefix text matches are discounted.
- `countries`: nonempty `name_locales` (locale tags), uppercase two-letter `ambiguous_codes` that remain ordinary text,
  and `extra_aliases` (uppercase country code to a nonempty list of names). Country names come from the market table,
  its aliases and `Intl.DisplayNames`; `match: false` countries stay out of free-text recognition.
- `palette`: `min_chars` (integer 1–10) and `limit` (integer 1–50), used by the quick-open search endpoint.

Search defaults to title, company display name/aliases, each location's city/label and recognized countries.
`/jobs?searchIn=all` also searches the original description and current translations with matching source hashes;
stored translation markers are excluded. Fields are normalized with NFKC at query time without changing stored data.
Short Latin words require whole-word matches, longer words allow prefixes, quoted phrases stay within one field,
and programming terms such as `C++` are literal; a term with a leading dot such as `.NET` also matches `ASP.NET`.
Country names also match text; unambiguous bare codes match only country codes, while ambiguous codes remain text.
A code alone (`DE`, `de`) is a country; in a longer query only a code typed in capitals is (`engineer DE`), so
`chef de projet` keeps `de` as a word. Quote a code (`"DE"`) to search it as text. `/jobs?country=DE&country=FR` applies an exact OR country filter.
Country and search scope are URL-only and are never saved in views. A nonempty query defaults to descending relevance
unless a sort was explicitly chosen; relevance ignores `dir`. The other sort defaults are unchanged.

Case-insensitive matching of non-ASCII letters (`ü`/`Ü`, `é`/`É`) depends on the database locale. The Docker stack's
database uses `en_US.utf8` and folds them; a database created with the `C` locale folds ASCII letters only.

To change these settings, write the keys you change into a file of that name in the user config directory ([overlay](#your-file-is-an-overlay)); the rest follows shipped updates.

## Commands

Run these in the project directory.

```bash
pnpm config:init                  # create the user directory, copy missing user files and profile templates; existing ones are untouched (safe to repeat)
pnpm config:init --from <dir>     # copy from another directory (for migrating an old install), and also copy shipped files that differ from the defaults
pnpm config:init --env-only       # only create .env (a new install's database password), touch no config file
pnpm config:migrate               # list the files to migrate and their diffs, write nothing
pnpm config:migrate --write       # migrate: first back up the original files to data/config/.backup/<timestamp>/, then write
pnpm config:migrate --prune-backups  # delete all but the newest schedule.yaml: config_writes.backups_keep (5) of those backup folders
pnpm config:plan [--deploy] [--check]  # list the writes that are waiting, write nothing; --deploy adds the files config:init would create; --check exits 2 while any is pending (0 none, 1 a file cannot be migrated)
pnpm config:check                 # validate both layers (default-directory files must be valid even when overridden), print which layer each file is read from and the shipped config identity
pnpm config:check --overrides     # every key each overlay file overrides or unsets; a protected key shows no value, only numbers, booleans and short plain strings show; anything else shows its shape, e.g. `(list, 3 items)` (`--json` available; see "What your files change")
pnpm config:check --effective     # per file: the layer it is read from and a hash of its effective value (`--json` for a machine-readable list; see below)
pnpm config:example               # list the example setups; `pnpm config:example <id> [--dry-run]` applies one (see below)
```

Nothing writes at start-up, and `--write` does not delete old backups: the files are written by these commands, by saves
in the web, and by step 11 `config-write` of `scripts/ops/deploy.sh`, which runs `config:migrate --write`, `config:init`,
`config:plan --deploy --check` and `config:migrate --prune-backups` once the new worker is confirmed and no older worker
runs. If that gate or a write fails the deploy ends with exit 2 and the next deploy retries; the doctor shows what is
left as `config.pending`. Until a file is written it is read from the shipped defaults (a missing file) or migrated in
memory (an older format). Step 4 of the deploy only previews. A host command that writes needs the database (see
[Config write lock](#config-write-lock)). A target version without the config-write step uses its own older step 4
(see [downgrades](upgrade.md#downgrade-pre-config-write-step)).

### Salary (`salary.yaml`)

The salary benchmark uses only salaries stated in postings; AI lookups are only displayed. The `salary.yaml`
configuration migration from `config_version: 1` to `2` removes `benchmark.include_ai_lookups` and its comment.
`scripts/ops/deploy.sh` previews it in step 4 and writes it in step 11 (`config-write`). For a manual upgrade, stop old
consumers and run `pnpm config:migrate` first to
see what the step removes, then `pnpm config:migrate --write` to save it (originals go to `data/config/.backup/`).
Older files are migrated in memory when loaded; adding this key to a v2 file fails validation as an unknown key.
See [salary.md](salary.md) for the cards and [the changelog](../CHANGELOG.md) for upgrade and rollback notes.

### Gmail replies (`replies.yaml`)

Off by default (`enabled: false`). Reads one Gmail label read-only with local rules and suggests status changes on `/pipeline`; you confirm each one. `label`, `lookback_days`, `max_messages_per_cycle` (mails read and stored per cycle), `max_fetches_per_cycle` (mails fetched, failed ones included), `body_scan_chars`, `max_message_bytes`; `categories` (patterns per language, `categories.*` merge language by language); `match` (statuses, weights, `min_score`, `min_margin`, `company_scan_chars`, `common_word_names`, `ats_vendor_names`, sender lists); `transitions` (what each category suggests from which status); `storage` (subject and quote lengths, `decided_retention_days`); `panel.undo_days`; `doctor.pending_warn_days`. See [gmail-replies.md](gmail-replies.md).

### Company background (`research.yaml`)

A new file, off by default (`enabled: false`). An install that has none uses the shipped defaults, so nothing changes until you turn it
on. It is read afresh for every request. The site list refuses private addresses, local names and public suffixes when the file is
loaded. The `auto` block sets [automatic research](research.md#automatic-research); a `research.yaml` without it behaves as `trigger: manual`,
so a file you already have changes nothing until you add the block. See [research.md](research.md).

### LinkedIn Monid (`sources.yaml`)

The default cascade is Bright Data → Apify → Monid → session → guest. Monid needs `MONID_API_KEY` in `.env`;
its provider, endpoint and API host are protected keys. The sources migration **3 → 4** adds its block with
`monthly_budget_usd = min(5, global cap)` and inserts it only into the exact previous default cascade.
Custom orders stay unchanged. Before rolling back to code that supports only version 3, restore `sources.yaml`
from `data/config/.backup/`, or remove the Monid block and cascade entry and set `config_version: 3`.
See [Monid](monid.md) for wallet setup, accounting, smoke and stops.

### Paid delivery ledger (`delivery-audit.yaml`)

This shipped file controls the [paid delivery ledger](sources.md#paid-delivery-ledger). To change it, write the keys you change into `data/config/delivery-audit.yaml` ([overlay](#your-file-is-an-overlay)).

| Key | Shipped value | Meaning |
|---|---|---|
| `config_version` | `1` | Configuration version. |
| `scope.channel_kinds` | `[paid]` | Channel kinds covered. |
| `scope.exclude_channels` | `[]` | Channel IDs excluded from the scope. |
| `checkpoint.write_timeout_ms` | `5000` | Database statement and lock wait limit in milliseconds for ledger writes. Failure finalization rolls back before a standalone run-close fallback, which gets the same limit. |
| `retention.days` | `45` | Retention for ledger items only; never raw postings. Run summaries remain. |
| `retention.warn_bytes` | `524288000` | Retained payload bytes above which doctor warns and the runner can prune expired items early. |
| `prune.every_minutes` | `60` | Regular pruning interval. |
| `prune.batch_size` | `2000` | Maximum expired items deleted per statement. |
| `prune.statement_timeout_ms` | `5000` | Timeout per pruning statement in milliseconds. |

The threshold never skips new items or deletes unexpired ones. Database backups grow with the ledger: roughly 135 MB for 1,500 paid records a day over 45 days, depending on how many payloads are retained; one malformed provider response can add tens of MB.

### Activity log (`activity-log.yaml`)

This shipped tuning file controls the [activity log](sources.md#activity-log). To change it, write the keys you change into `data/config/activity-log.yaml` ([overlay](#your-file-is-an-overlay)). See the shipped `config/activity-log.yaml` for defaults and individual keys.

| Key | Meaning |
|---|---|
| `enabled` | Turns new recording on or off. Turning it off lets already started work finish recording. |
| `retention.days` | Days after last activity to retain inactive entries (30 by default). |
| `retention.max_events` | Event cap; the oldest inactive entries are removed when it is exceeded. |
| `capture` | Per-span event capture limit. |
| `writer` | Queue, batching, flush, timeout and retry tuning. |
| `prune` | Reconciliation and pruning interval, rows per transaction and entries per transaction. |
| `ui` | Pagination, refresh, initial range and deletion time budget. |
| `liveness` | Heartbeat freshness and startup grace for detecting active processes. |

Changes are picked up without a restart. Work actually in progress is not pruned.

### setup.yaml

`setup.yaml` holds the state of the first-run setup (`completed_at`, `completed_by`, `steps`); the setup wizard and
`pnpm run setup` write it. No `setup.yaml` means the setup is pending (every page opens `/setup`, the runner holds back
its scheduled cycles), whether or not other config files exist: nothing infers an existing install, and a deploy does not
add the file. Only a restore (or `pnpm config:init --from <dir>`) of a backup from before the wizard writes one marked
complete (`completed_by: existing_install`). An install from before the wizard that is upgraded in place therefore opens
the wizard once; finish or skip it, or run `pnpm run setup --complete`. An unreadable file counts as complete.
See [setup.md](setup.md) and [upgrade.md](upgrade.md#settings-during-an-upgrade).

## Example setups

The shipped defaults are deliberately neutral: one placeholder keyword group (`targets: [Software Engineer]`), no
company career boards (`ats_boards: []`), no extra title words for the board channels (`include_terms: []`), time zone
`America/New_York` and a US example market in the profile templates. The setup wizard (or `pnpm run setup`) replaces
them with your answers.

Ready-made setups ship as examples in `config/examples/<id>/`. Each holds an `example.yaml` (name, description) and
partial copies of `user` files with only the keys it sets. They are never read unless you apply one:

```bash
pnpm config:example                                  # list them
pnpm config:example ai-engineering-europe --dry-run  # show which settings would change
pnpm config:example ai-engineering-europe            # apply: back up the files that change to data/config/.backup/<timestamp>/, then write
```

Applying merges each file into your file in `data/config/` (comments kept): maps key by key, lists replaced, except
`ats_boards`, where the boards you do not have yet are added; `keyword_groups` is replaced only while it is still the
shipped placeholder, otherwise the example's groups are added next to yours. A list that replaces entries you have is named in a warning (also with --dry-run). Applying twice changes nothing.

| Example | What it sets |
|---|---|
| `ai-engineering-europe` | `search.yaml` keyword groups for AI / LLM / ML engineering, forward deployed and AI solutions roles; `sources.yaml` AI title words for the job board and company board channels and ten example company career boards (Greenhouse, Lever, Ashby, Personio, SmartRecruiters); `ai.yaml` translation glossary for those job titles. Market, cities and time zone are not part of it: pick them in the wizard (the example was made for the Germany pack, Berlin, `Europe/Berlin`). |

To share your own setup the same way, put a directory with an `example.yaml` and the partial files next to it.

## Protected keys (edited by hand only)

Some values decide which program the host runs or where a credential is sent. The runner and the host ai-worker run with
every secret of `.env`, so the web app (settings forms, advanced editor, setup wizard, source registry) may not change
these keys; you edit them by hand in the file in your config directory:

| File | Protected keys |
|---|---|
| `ai.yaml` | `providers.*.command` (the `claude` / `codex` executables), `providers.*.base_url` (OpenAI, OpenRouter, DeepSeek, MiMo), `providers.codex_cli.config_overrides`, `providers.codex_cli.disable_features`, `providers.codex_cli.trim_context` |
| `notify.yaml` | `telegram.api_base_url` |
| `sources.yaml` | every `base_url`, `api_base_url` and `eu_api_base_url`, `jobspy.url`, `jobspy.proxies`, `sources.gmail.host` / `port` / `secure`, `linkedin.session.site.auth_file`, `linkedin.apify.actor_id`, `linkedin.monid.provider`, `linkedin.monid.endpoint` |
| `resume.yaml` | `claude_command`, `claude_args`, `resume_kit_path`, `master_resume_path`, `pdf_dir`, `jd_export_dir`, `jd_export_host_dir` |
| `salary.yaml`, `research.yaml` | `lookup.allowed_fetch_domains`; `company.allowed_domains`, `company.non_company_hosts` (the hosts whose pages an AI CLI may open on this machine) |
| `ui.yaml` | everything under `web_access` (the login limits, see [Web access](#web-access-optional-password-bind-address-and-port)) |

- A save from the web is refused when the value of a protected key differs from the one in the file **and** from the
  shipped default. Writing back the value the file already has, or the shipped default (for example "Restore default",
  or a key that an older file did not have yet), is allowed.
- The settings forms show these fields read-only with a lock note; the advanced editor lists them above the text and marks
  a changed one as a problem on its line ("locked key"), so Save stays off.
- To allow the web to change them anyway (for example on a machine where only you can reach the web), set
  `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` in `.env` and restart the web (`docker compose up -d web`). The forms still show
  the fields locked; use the advanced editor.
- The list lives in `src/lib/config/protected-keys.ts`.

### Checked again where they are used

The lock above is the web side. The ai-worker and the runner do not trust the file either (it may have been edited by
hand, or with `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1`), so a few values are checked again where they are used, whatever the
file says (shipped values always pass):

- `ai.yaml providers.claude_cli.command` / `providers.codex_cli.command` must name the `claude` / `codex` executable (bare
  name or absolute path); `providers.codex_cli.config_overrides` keeps only the context switches set to `false`; the codex
  tool restrictions are always applied, whatever `disable_features` and `trim_context` say.
- `base_url` / `api_base_url` of the services that receive a credential (OpenAI, OpenRouter, DeepSeek, MiMo, Telegram, JSearch, Tavily, Brave,
  Apify, Monid) must point to the vendor's own host, and `sources.gmail` to `imap.gmail.com:993` with TLS, unless
  `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` is set in `.env`. Credentialed requests never follow a redirect.
- The claude / codex model names must be plain names (no spaces, not starting with `-`).

The two opt-outs are separate: `JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1` only lets the web write the keys,
`JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1` lets the processes send credentials to a host of your own. What happens when a check
fails is in [ai-providers.md](ai-providers.md#what-the-ai-worker-does-not-take-from-aiyaml); the doctor's `config.guards`
lists every value that is ignored or refused.

## Which host names reach the web (`JOB_RADAR_ALLOWED_HOSTS`)

The web answers only requests addressed to a known host name. This stops DNS rebinding: a web page of another site that
re-points its own name at `127.0.0.1` would otherwise talk to the dashboard as if it were the dashboard itself. Allowed
without any setting:

- `localhost`, `127.0.0.1`, `[::1]` (any port);
- `*.ts.net` (Tailscale: `tailscale serve`, MagicDNS).

The list never comes from a config file the web can write: `notify.yaml: public_base_url` (the link in Telegram messages)
does not add its host. A request whose `Host`, `X-Forwarded-Host` or `Origin` names anything else gets
`421 Misdirected Request` with a short explanation. A request that changes something (a form, a Server Action, anything
but GET / HEAD) must also come from the very address it is sent to: a page on another allowed host, such as another
machine of your tailnet or another program on `localhost:5173`, is a different site and is refused too. Only origins
listed in `JOB_RADAR_ALLOWED_HOSTS` are accepted besides the request's own host. If you reach the web under another name (a reverse proxy such as Caddy or nginx, a LAN name, a LAN IP), add
it to `.env` and restart the web:

```bash
JOB_RADAR_ALLOWED_HOSTS=jobs.example.com,*.home.example,192.168.1.20
```

Entries are comma-separated host names or IP addresses (IPv6 in brackets); `*.example.com` allows every name below
`example.com` (the part after `*.` needs at least two labels, so `*.com` is ignored); `name:port` allows only that port.

A reverse proxy **must** forward the public host name, as `Host` or as `X-Forwarded-Host` (Caddy does by default; with
nginx use `proxy_set_header Host $host;` or `proxy_set_header X-Forwarded-Host $host;`). Otherwise forms and actions are
refused, because the browser's origin does not match the address the web sees. For the Docker image, the Server Actions
origin list is fixed when the image is built; forwarding the host makes it unnecessary.

## Web access: optional password, bind address and port

By default the web listens on `127.0.0.1:3000` only and has no login: on your own machine nobody else can reach it, and
your phone comes in through `tailscale serve`. A password is optional. Set one when anybody but you can reach the
dashboard: through `tailscale serve` on a tailnet you share, on the LAN, or behind a reverse proxy.

```bash
pnpm web:password            # asks twice (no echo), prints one line
# JOB_RADAR_WEB_PASSWORD_HASH=scrypt:131072:8:1:...   -> paste it into .env
docker compose up -d web     # the web reads .env when the container is created
```

The variables (all in `.env`, never in a file the web can write):

| Variable | Default | Meaning |
|---|---|---|
| `JOB_RADAR_WEB_PASSWORD_HASH` | empty | The password as an scrypt hash from `pnpm web:password` (recommended). Empty = no login. |
| `JOB_RADAR_WEB_PASSWORD` | empty | The simple form: the password in plain text. When both are set the hash wins. The doctor suggests the hash. |
| `JOB_RADAR_WEB_BIND` | `127.0.0.1` (compose) | The host address compose publishes the web on, and the address `pnpm start` / `pnpm dev` listen on. `0.0.0.0` (or a LAN address) opens it to the network: set a password first; the doctor fails `compose.web` otherwise. Outside compose, unset means every interface (and no local exemption, see below). |
| `JOB_RADAR_WEB_PORT` | `3000` | The host port of the web (a second instance needs its own, see [multiple-instances.md](multiple-instances.md)). The doctor follows both. |
| `JOB_RADAR_SESSION_SECRET` | generated | The key that signs the session cookies. Unset: 32 random bytes are written to `data/config/.web-session-secret` (mode 0600) on first use. Set it (at least 32 characters) only to share sessions between machines. |
| `JOB_RADAR_WEB_LOCAL_LOGIN` | empty | `1`: requests from this machine need the password too (see below). Recommended whenever the web is reachable from elsewhere. |

How it behaves with a password:

- A visitor without a session who opens a page goes to `/login` and comes back to the page after signing in. Everything
  else (API calls, forms, background requests) answers `401` until then. `/api/health` stays open for health checks.
- A session lasts `ui.yaml: web_access.session_days` (30 days); the cookie is `HttpOnly` and `SameSite=Lax`. Over https
  (`tailscale serve` is https) it is called `__Host-jr_session` and is `Secure` (the browser then only sends it to this
  exact host, over https); over plain http it is `jr_session`. Sessions made over https before this cookie name existed
  are not carried over: after that upgrade you sign in once more on each device that comes in through https. The sign-out button is at the bottom of the sidebar (in the
  menu on a phone).
- Ending every session (a lost phone, a shared browser): **Settings → Signed-in browsers → Sign out everywhere** signs out every
  browser at once, this one too. It raises a counter in `data/config/.web-session-generation`; every session issued
  before is refused from then on, nothing else changes. Changing the password ends every session as well; so does deleting
  `data/config/.web-session-secret` (or changing `JOB_RADAR_SESSION_SECRET`) followed by `docker compose up -d web`.
- Failed logins are limited before the password is even checked: `web_access.login_max_failures` (5) within
  `login_window_minutes` (15) lock that source for `login_lockout_minutes` (15). The source is the last `X-Forwarded-For`
  address, the one the nearest hop saw (`tailscale serve` sets it to the device's tailnet address). Once
  `global_max_failures` (30) failures from all sources together fall within the window, every login has to wait after each
  further failure: `global_delay_seconds` (2) at first, twice as long each time, at most `login_lockout_minutes`. A browser
  that still has a valid session is not held up by that wait. At most `max_concurrent_logins` (4) checks run at once (each
  takes about 128 MB of memory for a moment). The web log records each lockout and the start of each wait, never the
  password or the address.
  `min_password_length` (10) is the shortest password `pnpm web:password` accepts. These keys are protected: change them
  by hand in `data/config/ui.yaml`.
- Signing in over plain http from another machine shows a warning on the login page: the password then crosses the
  network unencrypted. Use `tailscale serve` (https) or an https reverse proxy.
- A hash that cannot be read (copied incompletely, an old format) does **not** turn the login off: nobody can sign in, the
  login page says signing in does not work right now, and the doctor's `web.access` check fails. Run `pnpm web:password` again.

**From this machine without the password.** A request that names this machine (`Host` and `X-Forwarded-Host` are
`localhost`, `127.0.0.1` or `[::1]`), whose forwarded client address is loopback (in compose also a private address: the
Docker gateway), that did not come over https through a proxy and that carries none of the headers only a proxy adds,
skips the login, so the browser on the machine itself needs no password. A client can send all of these headers itself,
so the exemption is only on while `JOB_RADAR_WEB_BIND` is set to a loopback address, that is, while nothing but this
machine can connect:

- compose always sets it (`127.0.0.1` unless you change it) and publishes the port there;
- `pnpm start` and `pnpm dev` make the server listen on `JOB_RADAR_WEB_BIND` (or on `-H <address>` when you pass one).
  Without either they listen on every interface, and then **every** request needs the password, `http://localhost:3000`
  too. Set `JOB_RADAR_WEB_BIND=127.0.0.1` in `.env` to keep the exemption; `pnpm run doctor` warns (`web.access`) when a
  password is set, the web does not run in compose and the variable is unset;
- running `next start` directly is not supported here: it ignores `JOB_RADAR_WEB_BIND` and listens on every interface,
  so with `JOB_RADAR_WEB_BIND=127.0.0.1` in `.env` anyone on the network could claim to be `localhost`. Use `pnpm start`.
  It starts Next through `tsx`, a development dependency: run it in a checkout installed with plain `pnpm install`, not
  `pnpm install --prod`.

Any address that is not loopback switches the exemption off.

**The rule: `JOB_RADAR_WEB_BIND` must name the address the web is published on.** It is how the web learns it is
reachable from the network. Publishing it some other way (editing `ports:` in `compose.yaml`, a compose override, a port
forward) while the variable stays unset or `127.0.0.1` leaves the local exemption on; the doctor's `compose.web` check
fails with "local login exemption is still on". Set `JOB_RADAR_WEB_BIND` to the published address (and a password).

Residual risk: anything on this machine that passes connections on to the web looks local to it. That covers other
containers on the same compose network, a plain TCP forward (`tailscale serve --tcp`, `socat`, `ssh -R`, a router or VPN
port forward to this machine), and a reverse proxy on this machine that you configured to send `Host: 127.0.0.1` without
forwarding headers. `tailscale serve` in its normal https mode is safe: it adds the forwarding headers, so its visitors
always need the password. **When the web is reachable from anywhere but this machine, set `JOB_RADAR_WEB_LOCAL_LOGIN=1`**:
then every request needs the password, and you sign in once on the host as well.

Without a password, a red banner on every page says so whenever the dashboard is reached from another machine (or listens
beyond loopback), and the doctor's `web.access` check warns.

## Who may read the files

The web and the runner write config files with mode `0600` (owner only): `data/config/*.yaml` can hold tokens, and
`data/profile/` your profile. On Linux the containers run as `PUID:PGID` (default `1000:1000`), which must own `data/`;
see [host-setup.md](host-setup.md#10-linux). Docker Desktop on macOS maps ownership itself.

Two browser tabs (or a phone and the desktop) editing the same settings form or profile: the second save is refused (the file
was changed elsewhere) and the form shows the saved values, instead of overwriting the first. Every save of a
config file from the web also keeps the previous text in `data/config/.backup/editor/` (the advanced editor's
backups, `ui.yaml: config_editor.backups_keep` copies per file).

## Versions and migrations (`config_version`)

- Each config can carry a top-level `config_version: <integer>`; omitted = 1.
- The code has a current version for each file (the `to` of the last migration step in `src/lib/config/migrations/<file>/NNN-*.ts`).
- A file **older than the code**: it is migrated in memory before validation and works as usual; the doctor suggests running `pnpm config:migrate --write` to write the migration back (comments are kept, the original goes to `.backup/`).
- The last step of each file's chain (`overlay-format`) only changes the format: it is made by the deploy's write step, never in memory. `models.yaml` and the profile files do not have it.
- A file **newer than the code** (the code was rolled back): an explicit error (`ConfigError`, doctor shows a red failure), no guessing. Upgrade the code, or take the pre-migration file back from `data/config/.backup/<timestamp>/`.
- Files in the defaults directory ship with the product and are always at the current version (checked by `config:check`).

### Comparing the effective config (`config:check --effective`)

`pnpm config:check --effective` prints one line per config file: where it is read from (`user` / `default`) and a
canonical hash of the value the loader makes of it (after migrating in memory, validating and filling in defaults). Key
order, comments, quoting and `config_version` do not change the hash; a different value does. Run it before and after
an upgrade or a hand edit: equal hashes mean the same effective config. A file that does not load is marked `✗` with
the error (file and field, never the contents) and the command exits 1. `--json` prints
`{"files": [{name, file, layer, hash, error}]}`.

### YAML tags

A tag the parser does not know (`!foo`, a misspelt `!unset`, `!!int x`) is an error naming its line, in every reader
of config files: the loader, the settings page and the advanced editor, migrations, examples and the sources import.
Earlier versions only warned and read the value as a string. The one tag of our own is `!unset`
([Your file is an overlay](#your-file-is-an-overlay)); everywhere it means nothing, it is refused with its reason.

Writing a migration (for developers): in `src/lib/config/migrations/<file name>/NNN-slug.ts`, export a `{ from, to, description?, migrate(doc) }` (`to = from + 1`; `migrate` edits the yaml `Document` in place, keeps comments, and does no I/O), register it in order in `CONFIG_MIGRATIONS` in `migrations/index.ts`, and change the default-directory copy of the file to the new format with the new `config_version`. The contract is in `src/lib/config/migrations/types.ts`.

## Shipped config identity

The shipped defaults directory (`config/`, or `JOB_RADAR_DEFAULTS_DIR`) has an identity: a sha256 over a manifest of its
files, one line `<sha256>  ./<relative path>` per regular file, sorted by path in byte order (`LC_ALL=C`). `.DS_Store` and
`._*` files are left out at any depth; a symbolic link, or a file name with a newline or a backslash, is an error. People see
the first 12 characters. The same identity from the shell, in the directory:

```bash
cd config && find . -type f ! -name .DS_Store ! -name '._*' | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done | sha256sum
```

(on macOS without `sha256sum`, use `shasum -a 256`). Any change to a shipped file, a rename, an added or a deleted file
gives a new identity.

- `pnpm config:check` prints it after the profile line: `shipped:  config  c86995b8f48f` (the directory, then the short id).
  A directory that cannot be identified is a failure of `config:check`.
- The running processes report the identity they run with, in the database (`runtime_state` key
  `shipped_config:<web|runner|ai-worker>`: the full id, the directory, the host name, the PID and the process start; the
  row's time is the database clock). The web reports at start-up and, until one write worked, again on each `/api/health`
  request (each attempt limited to `schedule.yaml doctor.probe_timeout_seconds`, so a stuck write is abandoned and
  retried); the runner and the ai-worker (as a service) report at start-up and refresh the report with every heartbeat,
  under the heartbeat's time limit. A failed report is only a warning in that process's log (`could not report the
  shipped config`); it never stops the process or fails a heartbeat.
- `pnpm run doctor` check `config.shipped` (group "data") shows the identity of each process and checks that each report
  comes from the process running now: for web and runner (when they are in `doctor.compose_services`), the report's host
  name is the start of the running container's id, and the report was written no earlier than the container's start
  minus `schedule.yaml doctor.shipped_report_skew_seconds` (default 2, for the clock difference between Docker and the
  database); for the ai-worker (with `ai.yaml execution: host`), the report is newer than `host_worker.offline_after_seconds`
  and its PID is the one launchd (`launchctl print`) or systemd (`systemctl --user show -p MainPID`) gives for the service.
  When the service manager gives no PID, the report cannot be matched. The ai-worker's report must also come from a
  release directory of this checkout (`<checkout>/data/releases/ai-worker/<commit>/config`) whose commit is the
  checkout's HEAD: a worker from outside `data/releases/ai-worker/` (installed by a version from before release
  directories) or from another commit (after a worker-only rollback, or a deploy that stopped before its ai-worker step)
  is a warning with its own hint. Everything that cannot be confirmed is a warning
  that names each process; there is no failure. Without the database the check is skipped. The check also warns when a
  running container of the project has something mounted on `/app/config` (or below it): that would hide the defaults in
  the image, typically a `compose.override.yaml` from before they moved into the image; remove the mount and deploy.

Container reports can arrive late just after a deploy or restart: wait a minute and run the doctor again.
For the ai-worker, check whether `aiworker.heartbeat` says its current process is not confirmed yet; if its report stays
missing, look for "could not report the shipped config" in `data/logs/ai-worker.out.log`.

The ai-worker's release directories and its switch are set by four keys in `schedule.yaml`. None of them is in the
shipped file; add one to `data/config/schedule.yaml` only to change it (a version from before release directories does
not know them, see [upgrade.md](upgrade.md#downgrade-pre-release-dir)):

| Key | Default | Meaning |
|---|---|---|
| `deploy.ai_worker_releases_keep` | 3 | Release directories kept after a switch, the installed and the previous one included (at least 2) |
| `deploy.ai_worker_stop_timeout_seconds` | 60 | launchd `ExitTimeOut` / systemd `TimeoutStopSec` of the worker (at least 10) |
| `deploy.ai_worker_swap_timeout_seconds` | 120 | Longest wait of each phase of a switch (at least the stop timeout + 10), and the step 11 wait cap (`--settle` overrides it) |
| `doctor.shipped_report_skew_seconds` | 2 | Clock difference allowed between Docker and the database when `config.shipped` matches a container's report |

Details: [deploy.md](deploy.md), "The ai-worker runs from a release directory".

## Company filter and overview (`ui.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `filters.company_options_max` | 500 | Companies loaded into the company filter of `/jobs` (the ones with the most jobs); 1 to 5000 |
| `filters.company_options_visible` | 50 | Companies shown before you type in the drop-down's search box; 1 to 5000 |
| `companies.page_size` | 50 | Rows per page of `/companies`; 1 to 500 |

These keys may be missing (the defaults apply); a file without them needs no migration. The `companies` block may also be
omitted. Edit the overview page size in YAML or the advanced editor.

Rolling back to a version without the company filter: `interests.yaml` views and `ui.yaml` are strict, so the older
version refuses a file that holds the new keys (and the push step cannot read `interests.yaml` either). Before switching:

1. Stop writing: `docker compose -p job-radar stop web runner`, and let a cycle that is running finish.
2. Back up `data/config/interests.yaml` and `data/config/ui.yaml`.
3. Remove every `company:` key from the views in `interests.yaml`.
4. Remove `filters.company_options_max` and `filters.company_options_visible` from your `ui.yaml`, and the whole
   `companies:` section, even if you never added it (saving the settings writes it back with its defaults; leaving
   `companies: {}` is refused as well).
5. Check both files with the older version (`pnpm config:check` or `pnpm run doctor` in its image).
6. Switch to the older image and start the services.

Rolling back only the company overview (to a version that has the company filter but no `/companies`): do steps 1,
2, 5 and 6, and in between remove the whole `companies:` section from your `ui.yaml`; views and the `filters.*` keys stay.

The shipped `ui.yaml` is part of the image, so it goes back with it.

## Date filter (`ui.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `filters.date_quick_ranges` | `[1d, 7d, 14d, month]` | The quick ranges of the date filter on `/jobs`, in this order: `Nd` = the last N×24 hours (N from 1 to 366), `month` = this calendar month so far in the `schedule.yaml` timezone. 1 to 8 entries, no repeats |
| `filters.date_default_field` | `posted` | The date the filter compares until a link says otherwise: `posted` (the first-seen date where a posting has no posted date) or `seen` (first seen) |

Both keys may be missing (the defaults apply); an older file needs no migration. `pnpm config:check` names the key of a
range that is not `Nd` or `month`. Links keep working when you change the list: a range in the URL that is not offered
any more still filters, and the filter shows no button for it. How the filter behaves: [usage.md](usage.md#filtering-by-date).

Rolling back to a version before the date filter: `ui.yaml` is strict, so the older version refuses a file that holds
these keys. If you added them (or a copy of the shipped file carries them), remove `filters.date_quick_ranges` and
`filters.date_default_field` before switching, and check the file with the older version. Saved views in `interests.yaml`
can hold `within` and `dateBy`: see [Upgrading with the date filter](upgrade.md#upgrading-with-the-date-filter) for what an
older version does with them.

## Recheck of watched jobs (`pipeline.yaml` + `ui.yaml`)

The maintenance step rechecks the posting pages of starred and followed jobs (see usage.md "Closed jobs"). Its keys
live in two files; the watched-recheck blocks may be missing (older files): the defaults below apply. The table also lists
the link-check settings shared by possibly-closed and unseen active jobs.

| File | Key | Default | Meaning |
|---|---|---|---|
| `pipeline.yaml` (shipped) | `lifecycle.possibly_closed_after_days` | 7 | Days unseen before marking possibly closed, only when every source channel has had a successful run since the deadline |
| | `lifecycle.dormant_after_days` | 30 | Days possibly closed before dormancy; integer 0–3650. 0 disables it and wakes existing dormant jobs at the next maintenance sweep. Optional, supplied by the schema when absent; the shipped file contains only a comment |
| | `lifecycle.unseen_link_check_after_days` | 14 | Days unseen before an active job gets a direct fallback link check, regardless of channel runs; 0 = off. Optional, supplied by the schema when absent |
| | `lifecycle.unseen_link_check_interval_days` | 7 | Least days between fallback checks of the same job. Optional, supplied by the schema when absent |
| | `lifecycle.max_link_checks_per_cycle` | 20 | Shared per-cycle cap for possibly-closed and unseen active jobs' link checks |
| | `lifecycle.link_check_timeout_ms` | 10000 | Per-request timeout for both kinds of link check |
| | `lifecycle.watch_recheck.interval_hours` | 72 | A watched job is rechecked at most once in this many hours |
| | `lifecycle.watch_recheck.max_per_cycle` | 10 | Jobs rechecked per run |
| | `lifecycle.watch_recheck.per_host_min_interval_ms` | 3000 | Least time between two requests to one site (robots.txt included) |
| | `lifecycle.watch_recheck.timeout_ms` | 10000 | Per request |
| | `lifecycle.watch_recheck.max_body_bytes` | 1048576 | Longest page read; the rest is not downloaded |
| | `lifecycle.watch_recheck.user_agent` | `JobRadar/2 (self-hosted job tracker; link check)` | Sent with watched rechecks and plain link checks of possibly-closed and unseen active jobs; its first word is the robots.txt product token |
| `ui.yaml` (user) | `job_checks.closed_recheck.enabled` | `true` | Off: no watched recheck (plain link checks of possibly-closed and unseen active jobs keep running) |
| | `job_checks.closed_recheck.extra_phrases` | `[]` | Your phrases (regex, case-insensitive), added to the packs' `closed_posting.phrases`. Only a safe subset is accepted: words, character classes, alternation `(a\|b)`, `\b`, optional parts `?` (at most 8) and `{n,m}` up to 5, at most 200 characters; no `*`, `+`, `{n,}` or backreferences. `pnpm config:check` names an invalid or unsafe one by its path. They search at most the first 200,000 characters of a page's visible text, within 250 ms per page (a page whose search runs out of time counts as not checked) |

The `ui.yaml` block is edited in the YAML or the advanced editor (no form). An older version rejects it: remove it before
rolling back.

Dormancy needs no config version bump or file migration: the new optional key has only a schema default and is not
written into user files by `config:migrate --to-full`. To roll back, remove `lifecycle.dormant_after_days` from your
user `pipeline.yaml` if you added it: older strict schemas reject it. Keep the database migration; older code ignores
the nullable markers and shows dormant jobs again. Re-upgrading sweeps stale markers and restores protection.


## Ghost job check (`pipeline.yaml` + `ui.yaml`)

Signs that a posting is not a real opening (see [ghost-jobs.md](ghost-jobs.md)). Off by default; both blocks may be
missing: the defaults below apply. The phrases live in the market packs (`rules.yaml` `ghost`, see
[market-packs.md](market-packs.md#ghost-job-patterns)).

| File | Key | Default | Meaning |
|---|---|---|---|
| `pipeline.yaml` (shipped) | `job_checks.ghost.per_cycle_limit` | 2000 | Jobs checked per cycle at most |
| | `job_checks.ghost.levels.watch` / `.likely` | 3 / 5 | Points for "watch" / "likely ghost" (1–50, watch ≤ likely); "likely" also needs a reason that is not about time or length |
| | `job_checks.ghost.long_open.tiers` | `[{days: 90, points: 1}, {days: 180, points: 2}]` | Days open since the trusted posted date and their points (1–10 tiers, ascending days 1–3650, points 0–10) |
| | `job_checks.ghost.long_open.first_seen_max_points` | 1 | Most points when only the first-seen date is known (0–10) |
| | `job_checks.ghost.repost_label.points` | 1 | The source labels it "Reposted" (0–10) |
| | `job_checks.ghost.reposted.min_gap_days` / `.points` | 30 / 2 | Relisted by the same source under a new id at the same place at least this many days later (1–3650 / 0–10) |
| | `job_checks.ghost.evergreen_wording.points` | 2 | The JD says talent pool / always open (0–10) |
| | `job_checks.ghost.evergreen_wording.title_points` | 3 | The job's title says it (0–10; 0 = the title is not read) |
| | `job_checks.ghost.thin_description.min_words` / `.points` | 120 / 1 | A full-text JD shorter than this, or without a duties section (0–5000 / 0–10) |
| | `job_checks.ghost.thin_description.infer_from_headings` | `true` | Without a current JD breakdown, the duties headings decide whether a long JD has a duties section. `false`: the headings are not read, so only a short JD counts (a current breakdown still decides, an empty duties list included) |
| | `job_checks.ghost.<signal>.enabled` | `true` | Each signal can be turned off |
| | `job_checks.ghost.quote_max_chars` | 280 | Longest quote (40–2000) |
| | `job_checks.ghost.negation_words_before` / `_after` | 6 / 5 | Words around an evergreen phrase searched for a negation (0–20); a pack with `negation_after: clause` searches after it to the end of the clause instead |
| | `job_checks.ghost.heading_max_chars` | 60 | Longest line read as a heading together with the next line (10–200) |
| | `job_checks.ghost.question_tag_max_words` | 6 | Most words of an invitation tagged on after a statement that keeps it a statement ("We are always hiring – want to join?"; 1–20); the invitations are the packs' `question_tag` ([market-packs.md](market-packs.md#ghost-job-patterns)) |
| `ui.yaml` (user) | `job_checks.ghost.enabled` | `false` | On: the cycle checks jobs and the pages show the marks and the filter |
| | `job_checks.ghost.trusted_companies` | `[]` | Company names never marked (matched by the normalized name, without the legal form, aliases applied); their marks disappear at once, closed jobs included |

An older version rejects `job_checks.ghost` in `ui.yaml`: remove it before rolling back.

## Visa check (`pipeline.yaml` + `ui.yaml`)

What a posting says about visa sponsorship (see [visa-sponsorship.md](visa-sponsorship.md)). Both blocks may be missing:
the defaults below apply. The patterns live in the market packs (`rules.yaml` `visa`, see
[market-packs.md](market-packs.md#visa-patterns)).

| File | Key | Default | Meaning |
|---|---|---|---|
| `pipeline.yaml` (shipped) | `job_checks.visa.per_cycle_limit` | 2000 | Jobs checked per cycle at most |
| | `job_checks.visa.max_quotes` | 3 | Quotes kept per job (1–10) |
| | `job_checks.visa.quote_max_chars` | 280 | Longest quote (40–2000); a longer sentence is cut around the phrase |
| | `job_checks.visa.negation_words_before` | 6 | Words before an "offered" phrase searched for a negation (0–20) |
| | `job_checks.visa.negation_words_after` | 5 | Words after it, up to the end of its clause, searched for a negation (0–20) |
| | `job_checks.visa.heading_max_chars` | 60 | Longest line read as a heading together with the next line (10–200) |
| `ui.yaml` (user) | `job_checks.visa.enabled` | `true` | Off: nothing is checked and no page shows it |
| | `job_checks.visa.badges` | `auto` | When the list badge and the /jobs filter show: `auto` (only when me.yaml `needs_visa_sponsorship` is true), `always`, `never` |

An older version rejects `job_checks.visa` in `ui.yaml`: remove it before rolling back.

## Overlapping cycles (`schedule.yaml` `skip_if_running`, `partial_cycle_wait`)

Only one cycle runs at a time. With `skip_if_running: true` (the default) a scheduled cycle (morning, evening, weekend,
or the start-up catch-up) that finds another cycle running decides by what that cycle covers:

- The running cycle collects every channel: the scheduled one is recorded as skipped (it would only repeat the work), and
  its summary names the running cycle.
- The running cycle collects only some channels ("Collect now" on `/sources`, a manual cycle with only some channels
  ticked, `pnpm cycle:run --channel`): the scheduled one waits for it and then runs, so a click shortly before 07:00 no
  longer costs the morning's full collection. It waits at most `partial_cycle_wait.max_minutes` and is recorded as
  skipped if the lock is still held then.

`pnpm reprocess` waits for the same lock before changing stored facts and holds it through the complete reprocess.
While it runs, collection cycles follow the same skip/wait policy. The lock has a dedicated database connection and is
checked on `RUNNER_HEARTBEAT_SECONDS`; losing that connection cancels the current work, and the caller waits for it to
stop before returning. A CLI cycle handles Ctrl-C and SIGTERM by cancelling its steps and finishing its row as failed.
Each new cycle also recovers unfinished rows left by a crashed CLI or a failed final write, without a runner restart.

| Key | Default | Meaning |
|---|---|---|
| `partial_cycle_wait.max_minutes` | 60 | Longest wait for a running cycle of only some channels; 0 = do not wait (skip it as before) |
| `partial_cycle_wait.poll_seconds` | 15 | How often the waiting cycle tries again |

The block is not in the shipped file (it is shown there as a comment); add it to `data/config/schedule.yaml` only to
change it (a key left out keeps its default). While a scheduled cycle waits, the runner starts no other manual cycle
(other buttons still run), so a row of "Collect now" clicks cannot keep it waiting; the queued clicks it covers end
as done once it runs. A manual cycle never waits: the runner takes requests one at a time, so a waiting one would hold up
the other buttons. When a running cycle already covers a manual request (a scheduled cycle of every channel), the
request ends as done and the button shows that cycle; otherwise it fails with "another cycle is running" as before.
The catch-up at start-up and `pnpm run doctor` (`cycle.last`) count only cycles of every channel when they look for a
missed slot. A waiting cycle has no row yet: a deploy that drains the runner meanwhile does not wait for it (the
catch-up runs it after the restart), and if it waits longer than `doctor.cycle_grace_minutes`, `cycle.last` reports
the slot as missed until it starts. LinkedIn sources form a cascade, and a cycle of every channel collects with its
first available source only, so a "Collect now" of a later source in the cascade is never covered by it.

Before rolling back to a version without `partial_cycle_wait`, remove the block from `data/config/schedule.yaml`:
older versions reject unknown keys.

## Cron times and daylight saving

A cron with one fixed time (such as `0 7 * * 1-5`) runs once per day on clock-change days: in the spring gap it runs at the first valid time after it, and in the repeated autumn hour it runs once. An interval cron (several hours, minutes or seconds, such as `*/30 * * * *`) may run extra in the repeated hour at fall back and skips the times inside the gap at spring forward.

## Log level (`schedule.yaml` `logging.level`, `JOB_RADAR_LOG_LEVEL`)

The web app, the runner, the ai-worker and `pnpm cycle:run` log at `info` unless told otherwise. `debug` adds the
diagnostic records: AI provider checks, a provider the router skipped, HTTP retries, a Telegram message from another chat.

| Where | Value | Meaning |
|---|---|---|
| `JOB_RADAR_LOG_LEVEL` in `.env` | `debug`, `info`, `warn`, `error` (case does not matter) | Wins over the config. Empty = not set. Any other value counts as not set (the config applies) and is reported once in the log, without the value |
| `schedule.yaml` `logging.level` | same, default `info` | Used when the variable is not set. Not in the shipped file: the default applies until you add it |

- **Add it to your existing `data/config/schedule.yaml`**, for example `logging:` with `level: debug` under it. Your file
  holds what differs from the shipped one, so a `schedule.yaml` at its current `config_version` holding only a `logging`
  block is fine. In a whole file of the older format the rest of the file has to stay.
- **A change to the file needs no restart.** The runner and the ai-worker follow it through their watcher (on Docker bind
  mounts file events are unreliable; the polling picks it up instead); the web app checks on demand, at most once per
  `JOB_RADAR_CONFIG_POLL_MS`. With `JOB_RADAR_CONFIG_POLL_MS=0` the web app does not check on demand: it takes a change
  made outside it only after a restart or when it writes the file itself (a save in Settings). Each process asks for
  the level again at most once per that interval (5 seconds when the interval is `0`), so it takes effect within a few
  seconds of the reload.
- **A broken `schedule.yaml`** keeps the last valid level until the process restarts (the loader keeps the last valid
  file). A process that starts with a broken file logs at `info`, says so once, and takes the level as soon as the
  file is valid again.
- **A change to `.env`** needs the containers recreated, `docker compose up -d` (a `restart` keeps the old
  environment), and the ai-worker restarted (it reads `.env` when it starts). A variable set only in your shell does not
  reach the containers.

Before rolling back to a version without `logging.level`, remove the `logging` block from `data/config/schedule.yaml`:
older versions reject unknown keys.

## Backup

Every backup, the runner's daily one (`backup.config_archive`, on by default) and `scripts/ops/backup.sh`, leaves a `….config.tgz` (`data/config` + `data/profile`, without `.backup/` and the sign-in key `.web-session-secret`) next to the database dump. The `backup` section of `schedule.yaml` also has `pre_migrate` (take a backup before a database migration), `keep_system` (how many safety backups of each kind to keep) and `keep_old_databases` (how many databases replaced by a restore to keep). `.env` and `.auth/` are in no backup. See [`backup-restore.md`](backup-restore.md), including "Restoring the configuration".

`scripts/ops/backup.sh` and `restore.sh` read `schedule.yaml` through the app's loader. When that cannot run (no node, no
`node_modules`) or the file is invalid, a strict shell reader takes over for `timezone` (and `restore.sh` for
`backup.max_age_hours`). Write `timezone` as `Region/City` (`Europe/Berlin`, `America/Argentina/Buenos_Aires`) or
`UTC`. The shell reader is stricter than the loader: one-part names the loader accepts, such as `Japan`, `GMT` or
`EST5EDT`, are unclear to it, and `backup.sh` then names that backup in UTC (with a warning). Only this fallback is
affected; the runner and the loader read those names as before.

## Switching from a single directory

Older versions kept the live configuration in git as `config/`. Preserve a separate copy of that live directory before
switching code. With old consumers stopped, import it using `pnpm config:init --from <saved-old-config-dir>` before
deploy fills missing user files; a directory from before the setup wizard also gets a completed `setup.yaml` that way.
Step 4 of the deploy only previews; step 11 (`config-write`) fills missing files and writes migrations after excluding
old workers. From then on the web app writes `data/config/`, and `config/` holds product defaults. See sections 4 and 5 of [`deploy.md`](deploy.md) and [upgrade.md](upgrade.md).

### Config write lock

Every write to a config or profile file takes a lock in the database, per file: saves on the settings pages, the setup
wizard, the advanced editor, `/me`, `/interests` and the source registry, and the commands `config:init`,
`config:migrate --write` and `pnpm run setup`. Source switches and boards, discovered board candidates, search-city
synchronization, workflow settings and interest edits read their current value inside the lock, so concurrent changes to
different fields are kept. The salary form, like the other settings forms and source imports, refuses a file changed
since its preview. Wizard market and target saves merge only their own preference fields.

Saves therefore need the database. With it unreachable they are refused ("Saving settings needs the database, and it
cannot be reached right now") and nothing is written; reading is unaffected. A host command needs a database it can
reach from the host (`DATABASE_URL`, or `POSTGRES_*` in `.env`) and says so when it has none. When another writer holds
the lock, a write waits up to `schedule.yaml: config_writes.lock_wait_seconds` (default 10) and then reports busy; a
command names the holder. The same block has `backups_keep` (default 5), the number of `.backup/<timestamp>/` folders the
deploy keeps. Neither key is in the shipped file; add the block to `data/config/schedule.yaml` only to change them.
`pnpm config:migrate --json` reports pending/problem counts without writing. An older version rejects the block as
unknown: remove it before rolling back. See [upgrade.md](upgrade.md#settings-during-an-upgrade).

## Current display scores (`current-scores.yaml`)

This shipped file controls the rebuildable display-score projection. A file of that name in the user directory is laid over it key by key.
`backfill.lock_timeout_ms` limits the migration's wait for the SHARE lock (100–60000 ms), and
`backfill.statement_timeout_ms` limits the backfill statement itself (1000–600000 ms). They are separate per-statement
limits, not a total migration timeout. `refresh.lateral_max_jobs` chooses indexed LATERAL lookups for small refreshes;
larger sets use the job-scoped CTE (1–100000 jobs). All keys are required. This file does not affect filter fingerprints.

## Watched company searches

`search.yaml` adds `watched_company_queries`: `enabled` (default `true`), `max_per_cycle` (3 per unit), `min_interval_hours` (24), and `max_results` (25 per query, further capped by the channel). Missing blocks or keys in existing user files receive these schema defaults; explicit `false` is respected. No database migration is needed.

Supported channel blocks in `sources.yaml` have `company_queries: true` by default: `linkedin.session`, `linkedin.guest`, `linkedin.brightdata`, `linkedin.apify`, `sources.arbeitsagentur`, `sources.indeed`, `sources.jobspy_google`, `sources.jsearch`, `sources.stepstone` and `sources.xing`. Change them on Sources → Registry → Details, or Settings → Channels. These switches authorize sending watched company names to the provider; see [Privacy](privacy.md) and [query behavior and capacity](sources.md#watched-company-queries). Settings → Search edits the global switch, cap, interval and result limit.

**Rollback:** to stop queries, set `watched_company_queries.enabled: false`. Before starting older code, remove the entire `watched_company_queries` block from `data/config/search.yaml` and every `company_queries` key from user `data/config/sources.yaml` (including any unsupported blocks written by a settings save). Run the older build's `pnpm config:check`; its strict schemas reject the new keys. Keep database history and raw postings.

## Career profile (`career.yaml`)

Off by default and independent of `writer.enabled`. Enable it under **Settings → Workflow**, then use the card on
My profile. See [Career profile](career-profile.md) for editing, extraction, history and deletion. Turning it off keeps the files.

`profile.max_entries`, `profile.max_bullets_per_entry`, `profile.max_wordings_per_text` and `profile.text_max_chars`
limit saves. `history.keep_versions` limits profile history; contact details have none. The schema supplies defaults for
every key and rejects unknown keys. `config_version: 2` uses the standard layered overlay format; the initial whole-file
format is version 1 and can be converted with `pnpm config:migrate --write --convert-overlays`.

`document.max_documents` limits saved résumé copies (1–1000). `document.image_max_bytes` limits each local JPEG or PNG
photo or signature (up to 20 MB), and `document.max_request_bytes` configures only the preview request body limit
(up to 50 MB). A document save request can carry at most 1 MB, like a profile save. A very large document can reach
that before the entry and wording limits; the save then fails with an error and your edits stay in the form.
`document.defaults` supplies `lang` (en/de), `theme` (minimal/band/classic/compact/split), `accent`, `pages` (1–10),
`paper` (a4/letter) and `density` (compact/normal/relaxed) for missing preferences. `preview.debounce_ms` configures the
preview delay (50–10000 ms). Open the editor at `/career/documents`; see
[Résumé documents](career-profile.md#résumé-documents) for editing and live preview.

Documents live in `career/documents/` under the profile directory and retain source references while being edited
independently. `history.keep_versions` applies separately to each document under `career/history/documents/` as well
as the profile. Contact is merged only for rendering; it is absent from document and history files. Preferences and
local images have no history. Deleting all career data removes documents, preferences, images and history together.

Extraction settings are `timeout_seconds`, `expiry_grace_seconds`, `queue_timeout_seconds`,
`import.formats`, `max_file_bytes`, `upload_timeout_seconds`, `max_chars`, `min_chars`, `pdf_timeout_seconds`,
`pdf_max_memory_mb`, `max_concurrent_uploads`, `draft_ttl_days`, `max_pending_drafts`, `output_truncated_share`,
`stored_value_min_chars`, `title_words`, `sensitive_labels` (all under `import` after `formats`), and
`evidence.min_quote_chars`, `quote_max_chars`, `figure_units` (all under `evidence`). Figure units share the writer's
scale and multiple defaults. The three top-level time settings limit running time, the expiry grace period and queue wait. Import settings control file types and size, upload and PDF processing time and memory, text length, concurrent uploads, draft expiry and count, suspected output truncation, and preview removal and highlighting rules. Evidence settings control quote length and figure verification. The `career_extract` task in `ai.yaml` selects the provider and model for extraction.

`writer.yaml: import.title_words` lists résumé title lines skipped when guessing a name.
`writer.yaml: import.sensitive_labels` lists labels highlighted for review in the outbound preview.
Résumé tailoring settings live under `tailor`: `max_requirements` (separate requirements per document), `requirement_max_chars`, `duty_min_coverage` (the share of a rewritten duty's content words that the quotes must cover), `max_proposals` (kept from one request), `jd_max_chars` and `jd_head_share` (how much JD is sent and how much of it comes from the beginning), and the word lists of the check: `first_person`, `names` and `stopwords` by language. `duty_min_coverage: 0.7` is a starting value measured on fictional samples and will be recalibrated with real model output. Tailoring uses the same three time settings as extraction, and the `career_tailor` task in `ai.yaml` selects its provider, model and `max_output_tokens` per call. See [Résumé tailoring](resume-tailoring.md).
