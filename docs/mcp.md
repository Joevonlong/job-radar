# Asking your AI client: the MCP server

[English](mcp.md) | [中文](mcp.zh.md)

Job Radar can answer questions from an MCP client you set up yourself, such as Claude Desktop or Claude Code: "what new jobs
are worth a look today?", "which applications have had no answer for two weeks?", "what does this job say about pay?". The
client starts `pnpm mcp:serve` as a local child process and talks to it over stdin / stdout.

- **Off by default.** Nothing happens until you set `enabled: true` in `mcp.yaml`.
- **Local only.** No port is opened and there is no token: only a program you configure on this computer can start it.
- **Read-only, with one permission-controlled exception.** The tools read over read-only database sessions. The only tool that can write,
  `save_application_answer`, requires `writer:write`, and all it can do is add an answer version. The server never starts a
  collection or an AI call.

The server also stores local call metadata in `agent_calls`, over a separate audit connection (see [Audit trail](#audit-trail)).

## What leaves your machine

**Whatever the tools return is passed by your client to the model provider it uses** (Anthropic for Claude, and so on), under
that provider's terms. Turning the server on adds this exit to the ones listed in [privacy.md](privacy.md).

| Given (when you ask) | Never given (no setting turns them on) |
|---|---|
| Job facts: title, company, locations, work mode, contract, agency flag, required German level, status, dates, skills | Your profile files (`me`, `preferences`, `interests`) and their saved snapshots |
| Source links (posting and apply links) | Private profile values as fields: salary floor, your language level, the labels of your deal-breakers |
| The stated salary | AI provider/model/usage, signal bonus |
| Score and rank numbers | Local paths (tailored résumé files) |
| Compensation and benefit signals with their JD quote and position | Emails and email replies |
| The JD after AI-trap cleaning (see below) | `.env` and `.auth/` values, keys, AI usage, notifications, run records, config file contents |
| Your applications: status, when it last changed, days in that status, next step and its date, interview rounds, the status history | |

The career profile itself (its files, documents, contact details and drafts) is never given; no MCP tool reads it.

These lists cover structured fields. Two permissions also give free text that no field list can hold back:

- With `match:read`, the AI-written summaries, fit reasons and gaps are free text written from your profile and the JD; they may
  mention things such as your language level or your salary expectations. Filter reasons carry deal-breaker ids and matched blacklist keywords and can indirectly reveal other preferences, including excluded companies, places, seniority and contract types; these examples are not a complete list. The labels you gave your deal-breakers are not returned as fields.
- With `notes:read`, your application, event and favorite notes are your own text and are given as you wrote them.

These texts pass the invisible-character and AI-instruction cleaner. The new readers and `list_applications` also redact recognizable email addresses, local paths and credential assignments in free text. Cleaning is not a guarantee that every personal detail is removed; grant these permissions only if the remaining text may leave your machine.

The list is fixed in code (`src/lib/mcp/dto/index.ts`); each answer is built field by field, so a new database column never shows up
by itself.

**Granting `writer:read`, which gives `get_application_context`, adds your own writing material to what leaves:** the job's breakdown points, its
application questions and settings, the saved answer versions with their sentence statuses and evidence quotes, and for each
question what you chose for it: your profile summary, skills and languages, the chosen stories, the emphasis note. Stories that **Apply to matching** wrote from the [career profile](career-profile.md) count like any other story: sent only when chosen. Stories you did
not choose, the rest of your profile files, coach reviews and saved snapshots stay out. It also gives the company background (AI web search,
unverified) and the fit note, with a notice that they are quoted data; the note keeps short quotes of the stories chosen when it was
made, even if they are no longer chosen.

## Turning it on

1. Open `mcp.yaml` (Settings → Advanced, or `data/config/mcp.yaml`) and set `enabled: true`. The global `permissions` matrix caps every connection; the local grant is
   `stdio.permissions`, and only their intersection is effective. Both default to `jobs:read` and `tracking:read`; `limits` caps how many items one call returns (`max_results`, at most 100) and how long a JD may be
   (`max_description_chars`).
2. Check it: `pnpm run doctor` shows `data.mcp` as on, with the global matrix and effective stdio permissions.
3. Add the server to your client (below), then restart the client.

The server reads `mcp.yaml` again on every call. Disabling it, removing a permission, or a file that can no longer be read
refuses the next call of a client that is already connected, without a restart; granting access needs a client restart.

`search_jobs` and `get_job` share `jobs:read`; `list_applications` needs `tracking:read`. Other ids from the permission catalog
are accepted; `match:read` adds match blocks to cards and details, and `notes:read` adds a block to `get_job` as described below. Version-2 tool switches migrate to both permission lists; if only one jobs tool
was off, `jobs:read` offers both and `config:migrate` prints a notice. Remove `jobs:read` to disable both. A permission
you write into `mcp.yaml` also covers tools that later versions add under it, so grant only what should be readable or
writable.

`budgets` reserves daily limits for future agent action tools; existing tools do not use these counters yet.
`per_caller` counts the local stdio connection and each token separately. It caps collection requests, job translations,
breakdowns, salary lookups, company lookups, answer drafts and resume tailoring; `score_jobs` counts each job in a batch.
Salary and company lookups also include automatic research started by an agent's write. An action cap of `0` forbids that
action. `total` counts requests, not jobs, across all callers and actions: a `score_jobs` batch of 40 jobs uses 40 of the
caller's `score_jobs` cap but only 1 of `total`. `0` forbids all agent actions.
The day and next reset follow `schedule.yaml`'s time zone, including daylight saving changes. The runner prunes counter rows older
than the current local day minus `audit.retention_days` once an hour. These settings have defaults and keep `config_version: 3`.

```yaml
config_version: 3
enabled: true
permissions:
  - jobs:read
  - tracking:read
stdio:
  permissions:
    - jobs:read
    - tracking:read
```

The server reads the database the same way the host-side `ai-worker` does: from `.env` in the project directory (or the
`POSTGRES_*` defaults, port 5433). The stack has to be running (`docker compose up -d`).

### Claude Code

```bash
claude mcp add job-radar -- pnpm --silent --dir /absolute/path/to/job-radar mcp:serve
```

Add `--scope user` to have it in every project. `claude mcp list` shows whether it connected.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "job-radar": {
      "command": "/absolute/path/to/pnpm",
      "args": ["--silent", "--dir", "/absolute/path/to/job-radar", "mcp:serve"],
      "env": { "PATH": "/folder/of/node:/usr/bin:/bin" }
    }
  }
}
```

- Use absolute paths: an app started from the Dock does not get your shell's `PATH`. `which pnpm` gives the command;
  `dirname "$(which node)"` gives the folder for `PATH` (pnpm needs `node`).
- `--silent` keeps pnpm's own header line off stdout, which belongs to the protocol.
- **Project on an external disk** (macOS): the first start may be blocked until you allow Claude to access removable volumes
  (System Settings → Privacy & Security → Files and Folders). The client's log for the server then shows a permission error.

Other MCP clients work the same way: a stdio server, command `pnpm`, arguments `--silent --dir <project> mcp:serve`.

## The tools

| Tool | What it does |
|---|---|
| `search_jobs` | Ranked job cards, filtered like the jobs list: `query` (title, company name/aliases, city/location and country), `search_in` (`summary` by default; `all` adds the original JD and current translations), `country` (1–20 two-letter exact codes, case-insensitive, OR), `city`, `workplace`, `min_rank`, `min_annual_salary` (in the market's base currency), `since` / `until` (first seen, `YYYY-MM-DD`), `application_status`, `sort` (`relevance`, `rank`, `posted`, `first_seen`; default `relevance` with a query, `rank` without one), `scope` (`current` by default, `archive`, `all`), `unseen_only` and `favorites_only` (both need `tracking:read`; without it a call that sets either to `true` is refused as `invalid_input`), `visa` (`offered`, `not_denied`), `ghost` (`only`, `hide`), `limit`. Hard-filtered jobs stay hidden in every scope; current scope also hides closed and dormant jobs. Visa and ghost filters apply only when their web filters are available. No JD text. |
| `get_job` | One job (`job_id`) in detail: everything above plus seniority, language, the signals with their quotes, the number of AI traps found, your application, and the cleaned JD. |
| `list_applications` | `tracking:read`: applications, best rank first; `status`, `stale_only`, `limit`. Stale uses `notify.yaml: reminders.interested_days` / `applied_days`, longest waiting first. Effective `notes:read` adds each item’s `notes.application_notes`; without it the existing field set stays unchanged. |
| `get_today` | `jobs:read`: today’s jobs and `quick_counts` for all/high/salary/following. Parameters: `view` (saved id or `all`), `quick` (`high`, `salary`, `following`), `include_filtered`, `hide_language`, `high_value`, `limit`. Uses the same saved-view, qualification and high-value rules as the page. A selected saved view wins over quick; without explicit toggles, an omitted view uses the default saved view. |
| `list_companies` | `jobs:read`: companies with jobs in the default jobs list, watched and blacklisted flags, job counts and highest rank. Parameters: `query` (display name), `sort` (`jobs`, `score`, `recent`), `limit`. |
| `get_company` | `jobs:read`: `company_id`, optional `limit`; aliases, stored website domain and whether it was user-confirmed or inferred, watched/blacklisted flags, stored background fields with source URLs, and active jobs in the default current list. No research is started. |
| `get_insights` | `jobs:read`: page statistics for `range` days (must be in `insights.yaml: ranges_days`; omitted uses the configured default), optional `limit`. Includes daily/source/city counts, salary and score histograms, signals and conversion counts. `tracking:read` adds application/funnel totals; `match:read` adds filter-reason counts. Personal salary floor and page navigation links are excluded. |
| `get_application` | `tracking:read`: application by `job_id`, with status, dates, next action, rounds, history, favorite/seen state, closure and filter override. `notes:read` adds application and event notes. Optional `limit` caps history and event notes; no closure note or résumé path. |
| `list_favorites` | `tracking:read`: all starred jobs, including closed, filtered and ignored ones. `sort`: `starred` (default, newest first) or `rank`; optional `limit`. `notes:read` adds each item’s `notes.favorite_note`. |
| `get_application_context` | **Off by default.** Everything to write one job's answers (`job_id`): job facts, the cleaned JD, breakdown points, the company background and fit note, the questions, the material chosen for each and the saved versions (newest first, at most `max_results` per question). |
| `save_application_answer` | **Off by default.** Adds one answer version (`job_id`, `question_id`, `text`, optional `sentences`). |

`search_jobs` uses the same URL-state filters as `/jobs`; absent scope keeps the legacy current-jobs rule, and dates compare first seen. As on the web, reversed `since` / `until` bounds are swapped; the previous MCP path returned no matches for such a range. Its search plan remains lenient: unreadable pipeline settings leave text search working without market vocabulary. Every explicit MCP sort has a web equivalent; MCP keeps rank as its default without a query, including archive (the web archive defaults to last listed).

Each search card keeps its existing facts. Effective `tracking:read` automatically adds `tracking: { status, favorite, seen }`, including with the default permissions. Effective `match:read` adds `match: { summary, summary_lang, summary_withheld, filter_result, filter_reasons }`. No other permission adds card fields; favorite notes and signal bonus are never returned by search. The one-line summary uses the MCP text locale, then the AI output language, English, or any stored language. It is withheld unless trap settings are readable and enabled and the job's scan matches its current JD, source payloads and rules. A withheld summary has null text/language and a strict-clean failure reason in `summary_withheld`; a card without a summary has null reason. Filter result/reasons remain available under match permission. All short text is cleaned. Given and withheld summaries each add at most one corresponding derived-content notice after the third-party notice and before truncation.

`get_job` returns `{ notices, job, <granted blocks> }`. The `job` object and the existing notices stay the same when no optional job blocks are requested. `include` accepts only `translation`, `breakdown`, `salary`, `company`, `ghost`, `lifecycle`; other blocks appear automatically with their effective permission (the intersection of global and connection grants). No ungranted block key is returned, even with `include`.

| Block | Effective permission | When included / content |
|---|---|---|
| `translation` | `jobs:read` | Named in `include`: all stored languages, cleaned text capped like the JD, stale flag and creation date |
| `breakdown` | `jobs:read` | Named in `include`: responsibilities, stack, experience, projects, soft skills, languages, other requirements, with guarded JD quotes; no profile matching |
| `salary` | `jobs:read` | Named in `include`: currency, annual figure, family id, benchmark, percentile, company count/median and cleaned stored lookup; no deep links, query or request counters |
| `company` | `jobs:read` | Named in `include`: stored research fields with cleaned text and safe source URLs, fetch date and expiry |
| `ghost` | `jobs:read` | Named in `include`: check state, level, score, date, dismissal and typed reasons; null while disabled; repost events omit source ids |
| `lifecycle` | `jobs:read` | Named in `include`: automatic status, closure reason, last seen/listed/relisted dates, relist count, dormancy |
| `match` | `match:read` | Automatic: summaries, AI score, German deduction, scoring date, stale flag, fit/gap evidence, filter reasons, deal-breaker and visa evidence, skill/German/salary checks; null without a score |
| `tracking` | `tracking:read` | Automatic (also with the default permissions): application status/history/next action/dates/rounds, favorite date, seen flag, closure action/link-check outcome, filter override; no notes |
| `notes` | `notes:read` | Automatic: cleaned application, event and favorite notes, as you wrote them; an event note has its `from` / `to` status only when `tracking:read` is effective too, otherwise only its text and time; never the closure note |

Translations, breakdowns, company research, salary lookup content and the `match` block's AI summaries, fit reasons and gaps are withheld with the JD's failure reason whenever the JD cannot pass its safety check (the `match` block then has `available: false`; its numbers, filter result and checks remain). Empty research or lookup storage remains null. JD quotes use the same trap markers as the JD; a breakdown item, fit reason or gap whose quote becomes a marker uses that marker for its own text/name too. All text, including summaries, reasons and notes, goes through the text cleaner. Unsafe instruction-bearing source URLs become null. A derived-content notice follows the third-party notice when derived content is present; withholding adds one notice, regardless of how many blocks were withheld.

No permission releases resume paths, closure notes, emails, secrets, profile files/snapshots or private profile values as fields (salary floor, your language level, deal-breaker labels), AI provider/model/usage or run records. The free text of `match:read` and `notes:read` is described under the table at the top of this page. The writer's explicitly selected material remains the separate exception described above.

`get_job` still returns dormant jobs: `status` stays `possibly_closed`, and `closed_reason` is `dormant`.

Use `get_today` for the page’s today view, or `search_jobs` with `since` = today for a first-seen-date search. `list_applications` with `stale_only` gives waiting applications.

List answers report `total`, `returned` and `truncated`. In `get_company` these counts refer to open jobs; in `get_application` they refer to history events. Every collection in the new readers, including aliases, research fields, links, history and insight series, is capped by the lower of `limit` and `limits.max_results`. Nested truncation also sets `truncated` and adds a notice; aggregate totals and quick counts remain full counts. Invalid arguments return a category error.

The six new readers withhold posting-derived strings (including job titles, company names, aliases, domains and links) when the relevant trap scan is missing, outdated, unreadable or disabled. A withheld string is null or its collection is empty, and `text_withheld` explains why. Company text requires current scans for all associated jobs; insight text labels use all postings first seen in the selected window. Numeric statistics and user-authored notes remain available under their permissions. Notes still pass the short-field cleaner. These tools return no raw payloads and require no `raw:read`; presets are unchanged.

`list_applications` also withholds posting titles, company names and links without a current readable trap scan. To preserve its established schema, withheld titles/names are empty strings and links are an empty list; a notice explains the withholding. User-authored notes and next actions still pass the text cleaner under their permissions.

Today selection and company overview assembly live in shared domain readers. The detail page and job blocks share check and salary inputs; insights receives the MCP read-only database explicitly. The web pages retain their presentation and translations. On `/jobs`, the high-value filter loads its policy only when selected; unreadable interests hide signal decoration without stopping other lists.

## Writing answers from your client

Add `writer:read` (for `get_application_context`) and `writer:write` (for `save_application_answer`) to both `permissions` and
`stdio.permissions` (they also need `writer.yaml: enabled`; while
the writer is off they are not offered). Then your client's own model can write an answer and add it to the question on the job's
apply page, where you review, change or finalise it as usual ([application-writer.md](application-writer.md)).

`save_application_answer` can only add:

- It never changes or deletes a version and never touches the final answer. There is no argument that could.
- **At `writer.yaml: questions.max_versions_per_question` versions (not counting the final one) it refuses** rather than drop an
  older one. Generating in the workbench still drops the oldest; raising the limit also makes room.
- Nobody can set a status. With `sentences` (each with `text`, `about` and evidence quotes copied exactly from the material),
  Job Radar checks every sentence with the same rules as the workbench, against the material chosen for the question now.
  `text` must be the same answer as `sentences`, or nothing is saved. Without `sentences`, every sentence is stored as
  "External, unverified".
- Invisible characters are removed before saving. The version is labelled "From your AI client" and records no provider or model.

It uses a database connection of its own, opened only when `writer:write` is effective and the writer is enabled. All other tools stay on the read-only sessions. With the
[read-only role](#optional-a-database-role-that-can-only-read) below, saving fails with a database error: that role cannot write.

## AI traps and the JD

The reader of an answer is an AI, which is exactly what the [AI traps](ai-traps.md) in some postings aim at. So:

- `get_job` gives the JD only after the stored trap findings were taken out (hidden text and instructions to an AI are replaced
  by the markers of `traps.yaml: ai_input`). A signal quote that overlaps a finding is replaced by its marker as well.
- **The JD is withheld** ("JD not available") when trap detection is off (`traps.yaml: enabled: false`), when the job has not
  been scanned under the current rules yet (it will be on the next cycle, or run `pnpm traps:scan --write`), or when the
  findings cannot be read. The signal quotes are withheld then too (`quote: null`); the other fields of the job are still given.
- `get_application_context` follows the same JD rule. A breakdown point whose quote overlaps a finding is the marker in both its
  text and its quote; while the JD is withheld, no points are given.
- Short fields (title, company, locations, salary text, quotes, links, and in `get_application_context` the question texts, versions,
  stories and your other material) lose invisible characters; a field that carries an instruction to an AI is replaced by the marker.
- Notices come first, in this order: for `get_job`, "Job Radar found N pieces of text aimed at AI in this JD and removed them"
  (when it found any), then "The JD was cut at … characters" (when it was cut), then the notice that the posting texts are
  third-party content to be treated as data. `search_jobs` and `list_applications` give the third-party notice first, then the
  derived-content or withholding notices (when they apply), and last "N of M shown" (when the list was cut). Every answer has the
  third-party notice; derived-content or withholding notices follow it when applicable.

This lowers the risk; it cannot rule it out. A posting can always word an instruction in a way no rule recognises. With the save
tool off, the worst a trap can do is mislead your client's answer. With it on, a trap could also get a misleading answer version
added, so read what your client saved before you finalise it; it cannot change or remove anything that is there.

## The log

Each call writes one line to stderr (your client keeps it in its log of the server): the tool, how many items it returned, how
long it took, and whether it worked. Never the arguments or the results. Errors name a category only (`database`, `not_found`,
`invalid_input`, ...), never an address or a path.

## Audit trail

Each tool call also adds one row to the local `agent_calls` table. `tools/list` adds none. A row holds only its numeric id,
call time (`called_at`), caller and transport (both `stdio` today), nullable `token_id` (null today), capability id,
optional target type and numeric id (`job`, `application` or `question`), outcome (`ok`, `not_permitted`, `invalid_input`
or `error`), returned item count and duration in milliseconds. Only an `error` row has an `error_category`: a fixed
category such as `database` or `not_found`. Invalid input has no target. No row holds arguments, returned content or
message text, including error messages.

Reads still use read-only sessions. Their audit rows go one at a time over a dedicated connection with at most one
session, and the server waits for the row before answering, but never longer than `audit.write_timeout_ms` from the end
of the call, time spent behind other rows included. If the row fails or the deadline passes, the read still answers
normally and writes one additional stderr line with the failure category only (`timeout` for a passed deadline). A row
that timed out is not sent again, because the database may already have saved it; the server drops that session and the
next row opens a new one. A saved answer version and its success audit row are written in the same
transaction on the answer's write connection: both are saved or neither is. If that audit insert fails, the answer is
rolled back, the call fails and the server attempts to record the error over the audit connection. The existing stderr
call-log line is unchanged.

In `mcp.yaml`, `audit.retention_days` defaults to **90** (1–3650). The runner periodically deletes older rows, including
while MCP is off; without a running runner, they remain. Old database backups can still hold deleted rows. The other
`audit` keys bound the dedicated connection's waits:

| Key | Default | Bounds |
|---|---|---|
| `connect_timeout_seconds` | 2 seconds | 1–30 |
| `statement_timeout_ms` | 1500 ms | 1–60000 |
| `lock_timeout_ms` | 200 ms | 1–60000 |
| `write_timeout_ms` | 2000 ms | 100–10000 |

The idle-in-transaction timeout uses `statement_timeout_ms` too. `statement_timeout_ms` and `lock_timeout_ms` are enforced by the database,
`connect_timeout_seconds` by the server's client, and `write_timeout_ms` is the server's own deadline, so it also holds when the database stops replying. When the client goes
away, the server waits at most `write_timeout_ms` for running calls and their rows, then closes its database connections,
giving a query that is still running at most 5 more seconds. The `audit` timeouts, including `write_timeout_ms`, take effect on server restart;
retention is read afresh by the runner. Existing config files get these defaults without a version change. `pnpm run
doctor` reports the audit retention days in `data.mcp` when MCP is on.

## Optional: a database role that can only read

The read-only sessions guard against a mistaken write, but they are not a security boundary. For a hard one, give the server
its own role with `SELECT` rights only (`save_application_answer` then cannot save):

```bash
docker compose exec db psql -U jobradar -d jobradar
```

```sql
CREATE ROLE job_radar_ro LOGIN PASSWORD 'choose-a-password';
GRANT CONNECT ON DATABASE jobradar TO job_radar_ro;
GRANT USAGE ON SCHEMA public TO job_radar_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO job_radar_ro;
-- tables added by later migrations (run as the role that migrates: jobradar unless you changed POSTGRES_USER)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO job_radar_ro;
```

Then start the server with that role: add `"DATABASE_URL": "postgres://job_radar_ro:choose-a-password@127.0.0.1:5433/jobradar"`
to the `env` of the client entry (a value in the client's environment wins over `.env`). The password then sits in the client's
config file; keep that file private.

With this SELECT-only role, audit inserts also fail: reads still answer with the extra stderr line described above. To keep
the audit trail, allow the role to add audit rows and nothing else:

```sql
GRANT INSERT ON agent_calls TO job_radar_ro;
GRANT USAGE ON SEQUENCE agent_calls_id_seq TO job_radar_ro;
```

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| The client says the server exited; its log shows "The Job Radar MCP server is switched off" | `mcp.yaml: enabled` is `false`. Set it to `true` and restart the client. |
| "mcp.yaml cannot be read" | `pnpm config:check` names the setting. |
| A call fails with "has not granted …" | The required permission is missing from `permissions` or `stdio.permissions`. Add it to both and restart the client. |
| "No tools are available" | The effective permission set grants no available tools. Check both permission lists and `writer.yaml: enabled`. |
| `get_application_context` or `save_application_answer` is not offered | Its permission is absent from either list, or `writer.yaml: enabled` is `false`. Restart the client after changing either. |
| "text does not match sentences" | The client sent two different answers. Send the same one in both, or leave `sentences` out. |
| "already holds … versions" | See [Writing answers from your client](#writing-answers-from-your-client). |
| `command not found` / `spawn pnpm ENOENT` | The client does not find `pnpm` or `node`: use absolute paths and set `PATH` in `env` (see Claude Desktop above). |
| "The query failed (database)" | The stack is not running, or the database address in `.env` is not reachable from the host. `pnpm run doctor` checks both. |
| "The MCP audit row could not be written (…)" in the client's log | The call itself answered; only its audit row is missing. `database`: the server runs with a SELECT-only role (grant `INSERT` on `agent_calls`, see [above](#optional-a-database-role-that-can-only-read)), or the database has not been migrated to this version yet (deploy the update with `scripts/ops/deploy.sh`, see [upgrade.md](upgrade.md)); until then `save_application_answer` fails as a whole with "The query failed (database)", because the answer and its row are saved together. `database` also covers a locked `agent_calls` table (for example during a migration) or a slow statement, because `audit.lock_timeout_ms` and `audit.statement_timeout_ms` fire before `audit.write_timeout_ms` with the defaults. `timeout`: the database or network did not answer within `audit.write_timeout_ms`, or the write queue was too long. Later calls write their rows again once the cause is gone. |
| `search_timeout` | A `search_in: "all"` search ran past `job-search.yaml: query.all_scope_timeout_ms`. Narrow the query or filters, or search without `search_in: "all"`. |
| "JD not available" | See [AI traps and the JD](#ai-traps-and-the-jd). |
