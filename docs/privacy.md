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
| Replies from Gmail, only if you turn them on ([gmail-replies.md](gmail-replies.md)): sender domain, date, subject, a short quote, category, your decision | database table `email_replies` | subject and quote until `storage.decided_retention_days` after your decision (default 90); the rest until you delete the database |
| AI results (scores with reasons, translations, breakdowns, signals, trap marks, weekly suggestions with quotes) and AI usage records (model, tokens, duration) | database | until you delete the database |
| Company background results (each field with its source link, the provider and the model) | database table `company_research` | until you delete the database; turning the feature off keeps them |
| Application fit notes (points with their quotes from the company background and your stories, the provider and the model) | database table `application_fit_notes` | one per job, replaced by the next; removed with the job |
| Telegram messages that were sent (payload and message id), control requests and their results | database | until you delete the database; the material of a writing request (`writer_job`, `writer_fit`) and the text of story extraction (`story_extract`) and career extraction (`career_extract`) are removed from the request once it is done, failed or expired (`queue_timeout_seconds` while queued, `timeout_seconds` + `expiry_grace_seconds` while running, in `career.yaml` for career extraction and `writer.yaml` for writing and story extraction). A backup taken while a request is open keeps that material, and this includes the pre-migration backup at deploy: about 8 weeks for daily and weekly backups, longer for system and manual backups. Postgres heap and WAL can also keep it until vacuum and checkpoint. |
| Application questions and answer versions, with the evidence check of every sentence | database tables `application_questions`, `application_answer_versions` | until you delete the question (or the database); beyond `questions.max_versions_per_question` the oldest version goes |
| Career extraction drafts, with suggested fields and source quotes | `data/profile/career/drafts/` and configuration archives | until adopted, discarded, or expired under `career.yaml: import.draft_ttl_days`; backups can retain them |
| Story drafts extracted from your profile, a text or a résumé, with the passages they quote | database table `profile_story_drafts` | the text is cleared when you adopt or discard a draft; the row goes after `writer.yaml: import.draft_ttl_days`. See [Story extraction](#story-extraction) |
| Runner heartbeats | database | 24 hours |
| MCP call metadata: caller, transport, capability, optional target id, outcome/category, count and duration; never arguments, returned content or message text | database table `agent_calls` | `mcp.yaml: audit.retention_days` (default 90 days), pruned by the runner; older backups can retain deleted rows. See [MCP audit trail](mcp.md#audit-trail) |
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
| The AI provider you use: OpenAI (`codex` CLI or API), Anthropic (`claude` CLI or API), OpenRouter and the upstream provider it routes to (API), DeepSeek or Xiaomi MiMo (API, **off by default**). An API provider sends nothing until its key is in `.env` | **Scoring:** your profile summary, skills and years, language levels, **target titles, home city and other places, work modes, remote scope, seniority, salary floor, contract preferences, excluded companies, excluded keywords, your own scoring criteria** and the job description. **Weekly suggestions:** the jobs you marked (interested, preparing, applied, interviewing, offer, ignored) **with their status**, plus your preferences. **Translation, breakdown, signals, trap check:** only the job text. **Company background** (off by default): only the company name and a website domain you confirmed, sent when you press the button; the provider then searches the web. Never the title, the location, the JD, your profile or a domain inferred from postings ([details](research.md)). **Application writer** (off by default): only the material listed in the box above **Write**: the question and its settings, job title and company, the JD points you ticked or a JD excerpt, your profile summary, skills and languages, the stories you ticked and your emphasis note, sent when you press **Write**. **Improve my own draft** sends the text you pasted (with the same material, or with none of it for "language only"), and **Review** sends the version's text and that material. Your home city and visa status (`me.yaml`), your notes and your application notes are not sent. | every cycle; the writer only on your click | switch a provider off (`enabled: false` in `ai.yaml`, or Settings → AI), do not install its CLI or fill its key; switch the weekly suggestions off in `schedule.yaml` (`suggest.enabled`); leave `writer.yaml: enabled` and `research.yaml: enabled` at `false` |
| Career extraction AI provider | The confirmed preview text; see [Career extraction](#career-extraction) | when you confirm an extraction with the feature enabled | do not send the preview, or disable the career profile |
| Résumé tailoring AI provider | The blocks and the JD shown in the preview; see [Résumé tailoring](#résumé-tailoring) | when you confirm a tailoring preview with the feature enabled | do not confirm the preview, or disable the career profile |
| Automatic research ([research.md](research.md#automatic-research)): the AI provider of the task, which searches the web | the company name and a domain you confirmed; for a salary lookup the title, city, country and seniority; the JD to the breakdown provider. The timing reflects what you save and apply to | when you save a job, optionally when its status changes or for new high-score jobs, only with research on | `auto.trigger: manual` or `enabled: false` in `research.yaml` |
| Job sites and APIs: Arbeitsagentur, Indeed, LinkedIn, StepStone, XING, Google Jobs via JSearch, company career boards, Bright Data, Apify, Monid | your search keywords, your home city (the home country's name if you set none), the places you list, watched company names, and requests from your IP address (LinkedIn session: requests as your logged-in account) | every cycle; company queries only use supported, enabled channels | switch the channel off on Sources; stop all company queries with `search.yaml: watched_company_queries.enabled: false`, or opt a channel out with `sources.yaml: company_queries: false` in its block |
| Arbeitnow (free board API), Berlin Startup Jobs (public listing API), Handpicked Berlin (public job index, off by default), Berlin Design Network (one job-list page a day, off by default) | requests from your IP address, nothing else (they take no keywords or places) | every cycle | switch the channel off on the Sources page |
| Tavily or Brave (board discovery) | a search query such as "keyword jobs city" | daily, only with a key | do not set the key |
| Google (Gmail over IMAP) | login with your app password and reading one label | every cycle | switch the Gmail channel off; revoke the app password |
| Telegram | job title, company, score, the one-line AI summary, reminders, health alerts and, with the "Tailor résumé" button, the command text | when something is pushed | Telegram is off by default (`notify.yaml`); leave it off |
| `claude` in a terminal (resume-kit `/tailor`) | **your complete résumé** and the job description, when you run the command yourself | only when you run it | do not run it |
| The model provider of an MCP client you configured yourself (Claude Desktop, Claude Code, ...; **off by default**) | what its tools return when you ask: job facts, source links, scores and ranks, signals with their JD quotes, the JD after AI-trap cleaning, the status, dates, next step and interview rounds of your applications. With `include` under `jobs:read`: translations, breakdowns, salary context, company research, ghost and lifecycle. With effective `match:read`: summaries, fit/gap/filter reasons and match checks. With `tracking:read`: application history, favorite date, seen and closure state; search cards add only status, favorite flag and seen. Search cards with `match:read` add only the cleaned one-line summary/language, withholding reason and filter result/reasons; their summary requires a current trap scan and readable, enabled trap settings. With `notes:read`: application, event and favorite notes after text cleaning. `get_today`, `list_companies`, `get_company` and `get_insights` expose today jobs/counts, company facts/research/open jobs and statistics under `jobs:read`; `get_application` and `list_favorites` expose application details and favorites under `tracking:read`; insights application aggregates need `tracking:read` and filter-reason counts need `match:read`. `list_applications` adds application notes only with `notes:read`. Short facts and links are cleaned without requiring a trap scan; `get_company` research text requires a current, readable, enabled scan of its originating posting. `get_insights` cities and configured signal categories require `profile:read`; `get_today` explicit/default saved views also require `profile:read`, with `tracking:read` additionally required for application-status filters. Free text in these tools and `list_applications`, plus notes and next actions in `get_job`, redacts recognizable email addresses, local paths and credential assignments. The fields list holds back structured values only: the AI's summaries, fit reasons and gaps are free text written from your profile and may mention your language level or salary expectations. Filter reasons carry deal-breaker ids and matched blacklist keywords and can indirectly reveal preferences such as excluded companies, places, seniority and contract types; this is not a complete list. **Never, as fields:** profile files/snapshots, salary floor, your language level, deal-breaker labels, closure notes, emails, local paths, keys, AI provider/model/usage or run records. **Only if you switch on `get_application_context`:** the job's application questions and answer versions, and the material you chose for each question (profile summary, skills, languages, chosen stories, emphasis). See [mcp.md](mcp.md) | only when you ask your client | leave `mcp.yaml: enabled` at `false`, or remove the server from your client |

Nothing is sent to the project's maintainers or to any analytics service.

### Career extraction

With the career profile enabled, you can send a reviewed preview of a résumé or self-description to the `career_extract` provider in `ai.yaml`. Uploads are read in memory; the file and filename are not retained. The contact file itself is not sent. The preview replaces detected contact values and links, but detection can miss details: check highlighted and other text before sending. Project links are not extracted. See [Career profile](career-profile.md#extract-a-draft).

The confirmed text stays in a control request while queued or running and is cleared when it ends or is cancelled; database backups, old Postgres row versions, WAL and database logs can retain it, as described for story extraction below. Draft files contain extracted fields and quotes until adoption, discard or expiry, and configuration archives can retain them longer. Adopted content remains in the profile and its history. Deleting all career data cancels active requests and removes local drafts; an already-started provider call may continue, but not backups or provider copies. Provider retention depends on the provider and your settings.

Importing a resume-kit master résumé makes no AI call: the file is parsed in memory and not stored, contact values are
shown for confirmation and saved only to the contact file, and the rest becomes a local draft retained like an extracted
one until adoption, discard or expiry. Adding a story to the profile is local too and leaves `stories.yaml` unchanged.

### Résumé tailoring

With the career profile enabled, **Confirm and generate** on `/career/tailor` sends the `career_tailor` provider in `ai.yaml` exactly the blocks and the JD that the preview showed: the document's entries and texts, your profile facts as evidence, your emphasis and tone, the separate requirements, the job title and company and the cleaned JD, cut to `tailor.jd_max_chars`. Contact details, links, photos and signatures are not sent; contact values detected in other text are replaced, but detection can miss details. If the content changes after you confirmed, nothing is sent and you confirm again. The control request carries only ids and a checksum of the preview; the material is read from the local files when the request runs. Proposals are stored beside the document (`career/documents/<id>.proposals.yaml`) until reviewed or until the document is deleted, and backups can retain them. See [Résumé tailoring](resume-tailoring.md#what-is-sent).

### Story extraction

With `writer.yaml: enabled`, the stories card on `/me` prepares an editable preview of your profile summary and skills, pasted text or résumé. Only the preview text you confirm is sent to the `story_extract` providers in `ai.yaml`; there is no web search. Detected contact details and links are replaced, but detection can miss details, so review all the text. Story extraction does not use stored contact values for replacement, regardless of the career profile switch. You can enter a name and address in the preview for removal. When the career profile is off, it does not read that profile folder.

An uploaded file is read in memory and never written to disk, not even to a temporary folder; its name is not kept. The confirmed text goes into one `story_extract` control request, where it stays until the request ends: every way it ends (done,
failed, expired, cut off by a restart) clears the text in the same statement and leaves only the SHA-256 and the length. A
request is not retried after a restart.

What can remain after that:

- **Inside Postgres:** old row versions keep the text in the table files until autovacuum reuses them, and the write-ahead log
  keeps it until it is recycled. Normally that is hours.
- **Database logs:** a failed statement can be logged with its values by Postgres.
- **Backups:** a backup taken while a request is open keeps the text. Daily and weekly backups go after about 8 weeks;
  pre-migration, pre-deploy and manual backups stay longer, until you remove them.
- **Drafts and adopted stories:** a draft holds snippets of the text (each field and its quote) until you adopt or discard it, or
  until `import.draft_ttl_days`. An adopted story is yours to keep in `data/profile/stories.yaml` and holds what you adopted.
- **Error messages:** when a provider fails on this task or on `write`, logs and the provider health table record only the kind of error, not its message, which could echo your text.
- **The AI provider:** what it keeps is under [Where the AI providers keep it](#where-the-ai-providers-keep-it).

### Where the AI providers keep it

- **Subscription CLIs** (`codex`, `claude`) use the consumer terms of your ChatGPT or Claude plan. Job Radar starts them
  without a saved session, but how the provider uses the content (for example to improve models) depends on **your account
  settings**: check "Improve the model for everyone" in ChatGPT (Settings → Data controls) and "Help improve Claude" in
  Claude (Settings → Privacy), and switch them off if you do not want that.
- **API keys** are covered by the provider's commercial or API terms, which usually do not train on your data by default;
  read the terms of the one you use.
- **OpenRouter** is a router: it forwards each request to an upstream provider of the chosen model, which can be another
  company in another country (the default model's upstream may be DeepSeek, see below). Job Radar asks it to use only upstreams
  that do not store or train on prompts (`providers.openrouter.routing.data_collection: deny`). That is **not** zero data
  retention: an upstream may still keep requests for a while. Set `routing.zdr: true` in `ai.yaml` to allow only
  zero-data-retention upstreams (fewer models then work). Your OpenRouter account settings also apply. The "Refresh available
  models" button (and `pnpm models:sync`) reads OpenRouter's public model list with a plain `GET`: no key, no profile and no job
  text are sent, and it only happens when you click or run the command.
- **DeepSeek and Xiaomi MiMo** are operated from China; data sent to them is subject to Chinese law. They are off by default;
  switch one on only if you accept that.
- **DeepSeek through OpenRouter:** with an OpenRouter key and OpenRouter's default model (`deepseek/deepseek-v4.1-flash`),
  your data can reach DeepSeek's own China-operated upstream even though the `deepseek` provider is off. To avoid that,
  pick an OpenRouter model that is not DeepSeek's (Settings → AI → OpenRouter, or `providers.openrouter.model`), add
  DeepSeek to the ignored providers in your OpenRouter account settings, or leave `OPENROUTER_API_KEY` empty.
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
   (`/deletebot`) and clear the chat; log the LinkedIn session out; delete API keys you created only for this (Anthropic, OpenAI,
   OpenRouter, DeepSeek, MiMo, JSearch, Tavily, Bright Data, Apify, Monid).
6. **At the AI providers:** the `codex` and `claude` CLIs keep no local session from Job Radar, but your provider account may keep a
   conversation history or usage log according to your plan: delete it there if you wish.

There is no function to delete a single job or application from the web interface in this version. Deleting the database
volume (step 2) is the supported way to erase stored jobs and notes; start again with an empty one if you want to keep using
Job Radar.

## Optional career profile

`career.yaml: enabled` is false by default. When enabled, manual career facts, alternative wordings and profile history
are stored as local files under `data/profile/career/`. Contact fields live separately in `contact.yaml`, are never sent
to an outbound service, and are overwritten without history. The local file can include an optional unused photo name.
Extraction sends the confirmed preview to an AI provider. A contact location or other personal detail remaining in that preview can also be sent. An email or phone written into profile text is allowed
with an advisory warning; it remains in profile history until you remove that history.

Résumé documents, their history, layout preferences and the shared photo and signature are local files in the same
directory. Contact details are added only when a preview or PDF is rendered in memory and are never written to document
files. The optional `career-pdf` service (compose profile `career-pdf`) receives that HTML, contact details included,
over an internal Docker network: it has no data volume, no environment file and no internet access, keeps nothing after
printing and logs only status, size and duration. The PDF goes straight to your browser and is not stored by the app.

The files are readable and writable by the local web process, have mode `0600` when written by the app and enter the
configuration archive. They are not stored in long-lived database tables and are not exposed over MCP. They change matching only when you
confirm **Apply to matching**: that copies languages, skills, years of experience and optionally the summary into `me.yaml`,
and one story per experience into `stories.yaml`, never contact details or entry locations. Those saves are ordinary
profile saves, so earlier versions stay in the database's profile snapshots and in database backups, and deleting career
data does not remove them. Disabling retains the data and performs no cleanup. Delete controls remove local career
files only: backups, before-restore copies and content already sent to an AI provider remain. An older backup can
restore data deleted later. Retention differs for scheduled, manual and system backups; see
[Backup and restore](backup-restore.md#career-profile-copies) and [Career profile](career-profile.md).

## Agent action metadata

With `actions:run`, the MCP client receives only request ids, queue/cache state, remaining budget and reset time, notices,
and the status of its own action requests. Status contains timestamps, queue position, worker online state, allow-listed
error codes/counts and collection progress; never payloads or free-text results. Action tools use the existing collection
and AI queue, with the same outbound data and payload scrubbing as the corresponding web buttons.

`agent_budget_usage` stores caller/action/local-day counters; `agent_budget_tickets` stores refundable reservations with their
units and day. The runner prunes both using `mcp.yaml: audit.retention_days`. An `over_budget` audit row contains no arguments.
