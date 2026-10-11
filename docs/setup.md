# First-run setup

[English](setup.md) | [中文](setup.zh.md)

A new install starts with a setup wizard. After `docker compose up -d`, open <http://127.0.0.1:3000>: every page leads
to `/setup` until the setup is finished. On a machine without a browser, `pnpm run setup` asks the same questions in the
terminal. Both write the same files: there is no separate store, and every step can be changed again later on the normal
pages.

## The eight steps

| Step | What you choose | Written to |
|---|---|---|
| Language | Interface language (pre-selected from your browser), language of the AI texts, language job ads are translated into | `language.yaml`: `ui.default_locale`, `ai.output`, `translation.target`; the language cookie of this browser |
| Market | Market pack, home country, base currency, local language, cities (the pack's cities are offered; any city can be typed), remote scope, time zone (pre-selected from your browser). Picking another country brings its currency and main city, as long as you haven't set those yourself; the profile step then starts with that city | `preferences.yaml`: `market`, `locations`, `remote_scope`; `search.yaml`: `locations`, `remote_scope`; `schedule.yaml`: `timezone` |
| Profile | Summary for the AI, skills with years, languages with their CEFR level (a row for the market's local language is added), years of experience, visa, city | `me.yaml` (a profile history snapshot is kept) |
| Targets | Job titles, level, work modes, salary floor in the market currency, contract types, companies / keywords / student jobs to leave out | `preferences.yaml`; `search.yaml` `keyword_groups` (see below) |
| Sources | The channels of your market (the pack's own job boards are listed with a "local" mark; scraping and account channels are never pre-ticked and need a confirmation, see below), company career boards to add | `sources.yaml` |
| AI | Subscription CLIs and API providers: on / off, order, default and strong model, a test per provider | `ai.yaml` (checked against `models.yaml`) |
| Telegram (optional) | Push on / off (off until you switch it on), message language; whether the bot is set up, the last test message and a test button, or how to set it up with `pnpm run setup --step telegram` | `notify.yaml` `telegram.enabled`; `language.yaml` `notify.locale` |
| Review | What each step did, a readiness list (profile, channels, AI, runner and ai-worker), "run the first cycle now", finish | `setup.yaml` |

"Save and continue" writes the step's files at once (comments in the files are kept) and marks the step done; a value the
file would not accept is shown next to its field and nothing is written. "Skip" only marks the step skipped and writes no
configuration, except for Telegram: skipping it switches `telegram.enabled` off unless `TELEGRAM_BOT_TOKEN` or
`TELEGRAM_CHAT_ID` is set, so the push does not complain on every cycle. On `/me`, changing the locations offers to copy them
into the search cities (`search.yaml`: `locations`), which are a separate list. The step bar lets you go back to any step; it shows what the files say now.

**Search keywords.** While `search.yaml` still has the shipped example groups, they are replaced as a whole by one group,
`targets`, holding your job titles. Groups you changed yourself stay; only `targets` is added or replaced. The targets step
shows the result before you save.

**Scraping channels need a confirmation.** LinkedIn guest search, Indeed, StepStone, XING and the logged-in LinkedIn session
read pages whose terms of service may forbid automated access. They start unticked in a new installation, each row carries a
short risk notice, and as soon as you tick one a box "I have read the notes above and take responsibility for using these channels" must be ticked
before the step is saved (the server refuses the save otherwise). A channel that is already on and was confirmed before is
not asked again. Details and the list of channels: [sources.md](sources.md#scraping).

**Keys and tokens are never entered here.** The wizard only shows the variable names (`TELEGRAM_BOT_TOKEN`,
`JSEARCH_API_KEY`, `ANTHROPIC_API_KEY` …) and whether each is set. Put them in `.env`, then restart the stack with
`docker compose up -d` (restart the ai-worker too for AI keys). For Telegram, `pnpm run setup --step telegram` on the host
does all of it: see [telegram.md](telegram.md#1-set-it-up-with-one-command). The wizard also does not install the ai-worker or sign in
to `claude` / `codex` or LinkedIn for you: see [host-setup.md](host-setup.md), [ai-providers.md](ai-providers.md) and
[linkedin-session.md](linkedin-session.md).

Not part of the wizard (links on the review step): signal categories, push thresholds, the processing schedule and the
application workflow (Settings → Workflow, `/interests`).

## While the setup is not finished

- Every page navigation goes to `/setup` (the API, files and form submissions are not redirected).
- The runner holds back its scheduled cycles, the start-up catch-up and the weekly suggestions; it logs
  `setup not completed: skipping …` and records nothing as a failure. A cycle you start yourself (the wizard's
  "run the first cycle now", Settings → Manual actions) runs as usual, and so does the backup.
- `pnpm run doctor` warns at `setup.completed`; `cycle.last` explains that the scheduled cycles are waiting.

"Skip the wizard, I'll configure it myself" (under the steps) marks the setup complete right away. When the setup is
complete, scheduled cycles start at the next slot.

## Opening it again

Settings → Manual actions → "Open the setup wizard" (or simply `/setup`). On a finished setup the wizard opens in review
mode: no redirect, scheduled cycles keep running, and every save applies immediately.

## Command line: `pnpm run setup`

Run it in the project directory on the host (`pnpm setup` alone is pnpm's own command):

```bash
pnpm run setup                         # the eight steps, interactive; Enter keeps the value in [brackets]
pnpm run setup --step ai               # one step
pnpm run setup --step telegram         # set up the Telegram bot: token, chat, test message, .env, restart
pnpm run setup --step telegram --no-restart   # same, but only print the restart commands
pnpm run setup --answers answers.yaml  # unattended
pnpm run setup --status [--json]       # where the setup stands, with the readiness list (read-only: writes no file)
pnpm run setup --complete              # mark it complete without changing any configuration
pnpm run setup --lang en               # language of the questions (default: language.yaml cli.locale)
```

The AI step reads on this computer whether `claude` and `codex` are installed and signed in (`claude auth status`,
`codex login status`: no AI call is made). Without a database (stack not running) the profile files are still written;
their history snapshot is recorded the next time the profile is read, and "run the first cycle" only tells you how to
start one later.

The Telegram step asks for the bot token without showing it, finds the chat id from a message you send to the bot,
sends a test message, writes the three `TELEGRAM_*` lines of `.env` (keeping a backup) and recreates the services that
read `.env`; details in [telegram.md](telegram.md#1-set-it-up-with-one-command). The answers file never holds the token:
its `telegram` section only sets the push switch and the message language. Exit codes: 0 done, 1 a step or the completion failed, 2 bad arguments or an unreadable answers file.

### The answers file

Every section is optional: a missing section is recorded as skipped, an omitted field keeps what the file says now.
The file is validated before anything is written.

```yaml
language:
  ui_locale: en                 # en | zh: the default interface language (language.yaml ui.default_locale)
  ai_output: en                 # language of AI texts (a language code)
  translation_target: en        # job ads are translated into this language
market:
  pack: generic                 # a directory of config/packs/
  country: NL                   # ISO codes; leave out to take the pack's
  currency: EUR
  home_language: nl
  locations: [Amsterdam, Utrecht]
  remote_scope: home_country    # none | home_country | worldwide | {region: [eu, CH]}
  timezone: Europe/Amsterdam
profile:
  summary: Backend engineer moving into applied machine learning.
  skills:
    - { name: Python, years: 6 }
    - Kubernetes
  languages: { en: C1, nl: A2 } # A1–C2 or native
  years_experience: 7
  city: Amsterdam
  needs_visa_sponsorship: false
targets:
  target_titles: [Machine Learning Engineer, Data Engineer]
  seniority: senior             # all | entry | mid | senior | lead
  workplace: [hybrid, remote]
  salary_floor_year: 65000      # in the market's base currency
  contracts: { allow: [permanent], exclude: [temp_agency] }
  exclude_student_roles: true
  exclude_companies: [Example Staffing]
  exclude_keywords: [unpaid]
sources:
  enable: [greenhouse, lever]   # channel ids of sources.yaml
  acknowledge_scraping: false   # must be true to enable linkedin-guest, indeed, stepstone, xing, jobspy-google or a LinkedIn session channel
  disable: [linkedin-brightdata]
  boards:
    - { name: Example Co, ats: greenhouse, token: exampleco }
ai:
  order: [claude-cli, codex-cli, api]
  providers:
    claude-cli: { enabled: true, model: claude-sonnet-5-5 }
    mimo: { enabled: false }
telegram:
  enabled: false
  notify_locale: null           # language of the messages; null = the interface default
finish:
  complete: true                # mark the setup complete after the steps (default true)
  run_first_cycle: false        # queue a first cycle (needs the database)
```

## setup.yaml

The state lives in the user config directory, `data/config/setup.yaml` (see [configuration.md](configuration.md)):

```yaml
completed_at: null              # ISO time once finished or skipped
completed_by: null              # wizard | cli | skipped | existing_install
steps:
  language: { status: done, at: "2026-10-09T08:00:00Z" }
```

The setup counts as pending only when this file can be read and `completed_at` is null. An unreadable or invalid file
counts as complete (nobody is locked into the wizard) and `pnpm run doctor` reports it at `setup.completed`.

**Existing installs** never see the wizard: when the user config directory already holds config files but no
`setup.yaml`, the first start (web, runner or `pnpm config:init`) writes it with `completed_by: existing_install`. If you
delete `setup.yaml` from a configured install, the same happens again. To walk through the steps anyway, open `/setup`.
