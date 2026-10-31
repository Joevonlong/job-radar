# Privacy: what is stored, what leaves your machine, how to delete it

[English](privacy.md) | [中文](privacy.zh.md)

Job Radar is a single-user tool that runs on your own machine. It has no accounts, no telemetry, no update check and no
hosted service, and the pages it serves load nothing from the internet at run time (fonts are bundled). This page lists
what it stores, which outside services can receive some of your data, and how to remove everything. It is a technical
description, not legal advice.

## What is stored, and for how long

| Data | Where | Kept |
|---|---|---|
| Your profile (`me.yaml`: skills, years, languages, summary; `preferences.yaml`: target titles, cities, salary floor, excluded companies and keywords; `stories.yaml`: your experience library, never sent anywhere while `writer.yaml: enabled` is false) | `data/profile/` on the host | until you delete it |
| Every saved version of your profile (the full YAML text) | database table `profile_snapshots` | until you delete the database; there is no clean-up job |
| Configuration, including your own scoring criteria (`ai.yaml`) | `data/config/`, editor backups in `data/config/.backup/` | editor backups are capped; migration backups are not cleaned up |
| Applications, next steps, notes, favorites and their notes | database | until you delete the database (a favorite note goes when you remove the favorite) |
| Raw postings as received from each channel, and unparsed job-alert emails (whole message) | database table `raw_postings` | until you delete the database |
| Paid delivery ledger: provider payloads and unreadable response bodies; stored postings use a link and hash instead of a duplicate payload | Local Postgres, included in database backups | Ledger items: 45 days by default; run summaries remain until the database is deleted. Older backups can retain deleted items. |
| Email metadata (message id, sender address, IMAP uid) | database table `email_messages` | until you delete the database |
| AI results (scores with reasons, translations, breakdowns, signals, trap marks, weekly suggestions with quotes) and AI usage records (model, tokens, duration) | database | until you delete the database |
| Telegram messages that were sent (payload and message id), control requests and their results | database | until you delete the database |
| Runner heartbeats | database | 24 hours |
| Database backups | `data/backups/` | automatic: 14 daily and 8 weekly dumps; manual backups are never removed. A deleted record stays in older backups until those are removed. |
| Job description exports for resume-kit | `data/exports/jd/` | until you delete them |
| Logs | container logs (rotated), `data/logs/` (rotated), `~/Library/Logs/job-radar/` on macOS | rotated |
| Secrets: Gmail app password, Telegram token and chat id, API keys | `.env` | until you delete it |
| LinkedIn login state (only if you use the logged-in session) | `.auth/` | until you delete it |
| Temporary files of an AI CLI call | `$TMPDIR/jr-codex-*`, `jr-claude-*` | removed after each call (a killed process can leave one behind) |

The activity log lives only in local Postgres and stores IDs, codes, numbers and times, never message text, error text, URLs, job descriptions or Telegram messages. It adds no outbound connection. See [Activity log](sources.md#activity-log) for retention and deletion.

The delivery ledger stays on this machine and is not exposed through MCP or pages. Its retention is configurable in [delivery-audit.yaml](configuration.md#paid-delivery-ledger-delivery-audityaml).

There is no automatic retention for the other database tables listed above: raw postings, unparsed emails, notifications, control
requests and profile snapshots stay until you remove the database. Back up and keep `data/` out of cloud-synced or shared
folders: it holds all of the above. Backup files and the exported JD files contain personal data.

Archiving, dormancy and seen again delete nothing: jobs, postings, scores, translations and analyses stay on this machine.
Any future retention period would be off by default.

## What leaves your machine

| Who | What | When | How to stop it |
|---|---|---|---|
| The AI provider you use: OpenAI (`codex` CLI), Anthropic (`claude` CLI or API), DeepSeek or Xiaomi MiMo (API, **off by default**) | **Scoring:** your profile summary, skills and years, language levels, **target titles, target cities, work modes, remote scope, seniority, salary floor, contract preferences, excluded companies, excluded keywords, your own scoring criteria** and the job description. **Weekly suggestions:** the jobs you marked (interested, preparing, applied, interviewing, offer, ignored) **with their status**, plus your preferences. **Translation, breakdown, signals, trap check:** only the job text. Your home city and visa status (`me.yaml`), your notes and your application notes are not sent. | every cycle | switch a provider off (`enabled: false` in `ai.yaml`, or Settings → AI), do not install its CLI or fill its key; switch the weekly suggestions off in `schedule.yaml` (`suggest.enabled`) |
| Job sites and APIs: Arbeitsagentur, Indeed, LinkedIn, StepStone, XING, Google Jobs via JSearch, company career boards, Bright Data, Apify, Monid | your search keywords, search cities or home-country name, watched company names, and requests from your IP address (LinkedIn session: requests as your logged-in account) | every cycle; company queries only use supported, enabled channels | switch the channel off on Sources; stop all company queries with `search.yaml: watched_company_queries.enabled: false`, or opt a channel out with `sources.yaml: company_queries: false` in its block |
| Arbeitnow (free board API) | requests from your IP address, nothing else (it takes no keywords or places) | every cycle | switch the channel off on the Sources page |
| Tavily or Brave (board discovery) | a search query such as "keyword jobs city" | daily, only with a key | do not set the key |
| Google (Gmail over IMAP) | login with your app password and reading one label | every cycle | switch the Gmail channel off; revoke the app password |
| Telegram | job title, company, score, the one-line AI summary, reminders, health alerts and, with the "Tailor résumé" button, the command text | when something is pushed | Telegram is off by default (`notify.yaml`); leave it off |
| `claude` in a terminal (resume-kit `/tailor`) | **your complete résumé** and the job description, when you run the command yourself | only when you run it | do not run it |
| The model provider of an MCP client you configured yourself (Claude Desktop, Claude Code, ...; **off by default**) | what its tools return when you ask: job facts, source links, scores and ranks, signals with their JD quotes, the JD after AI-trap cleaning, the status, dates, next step and interview rounds of your applications. **Never:** your profile, match reasons and gaps, filter reasons, your salary floor, notes, emails, local paths, keys. See [mcp.md](mcp.md) | only when you ask your client | leave `mcp.yaml: enabled` at `false`, or remove the server from your client |

Nothing is sent to the project's maintainers or to any analytics service.

### Where the AI providers keep it

- **Subscription CLIs** (`codex`, `claude`) use the consumer terms of your ChatGPT or Claude plan. Job Radar starts them
  without a saved session, but how the provider uses the content (for example to improve models) depends on **your account
  settings**: check "Improve the model for everyone" in ChatGPT (Settings → Data controls) and "Help improve Claude" in
  Claude (Settings → Privacy), and switch them off if you do not want that.
- **API keys** are covered by the provider's commercial or API terms, which usually do not train on your data by default;
  read the terms of the one you use.
- **DeepSeek and Xiaomi MiMo** are operated from China; data sent to them is subject to Chinese law. They are off by default;
  switch one on only if you accept that.
- **Telegram** stores bot messages on its servers. They are not end-to-end encrypted. Anyone with access to the chat, your
  account or the bot token can read them.
- A **Gmail app password** gives access to the whole mailbox, not only the label Job Radar reads. Prefer a dedicated mailbox
  that only receives job alerts, and revoke the password when you stop.

The providers that are switched on and reachable (Settings → AI, `pnpm run doctor`) are the services that can receive your
profile summary and job text.

## Remove everything

Do this when you stop using Job Radar or want to erase your job-search traces. It cannot be undone.

1. **Back up what you want to keep** (for example `data/profile/` and `data/config/`), and copy it out of the project directory.
2. **Uninstall the installation:** stop the host AI worker, remove the containers, **delete the database volume `jobradar-pg`**
   (this is the step that deletes every stored job, application and note), delete `data/`, `.env` and `.auth/`, and the checkout.
   The commands are in [Uninstall](upgrade.md#uninstall).
3. **Backups and copies elsewhere:** delete `data/backups/` (it goes with `data/`), any backup you copied to another disk or cloud
   drive, and exported JD files and tailored résumés (`data/exports/`, your resume-kit output folder).
4. **Logs and temporary files:** `~/Library/Logs/job-radar/` on macOS, and `$TMPDIR/jr-*` if a killed AI call left something behind.
5. **Accounts:** revoke the Gmail app password (Google Account → Security → App passwords); delete the Telegram bot in BotFather
   (`/deletebot`) and clear the chat; log the LinkedIn session out; delete API keys you created only for this (Anthropic, DeepSeek,
   MiMo, JSearch, Tavily, Bright Data, Apify, Monid).
6. **At the AI providers:** the `codex` and `claude` CLIs keep no local session from Job Radar, but your provider account may keep a
   conversation history or usage log according to your plan: delete it there if you wish.

There is no function to delete a single job or application from the web interface in this version. Deleting the database
volume (step 2) is the supported way to erase stored jobs and notes; start again with an empty one if you want to keep using
Job Radar.
