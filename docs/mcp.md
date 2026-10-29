# Asking your AI client: the MCP server

[English](mcp.md) | [中文](mcp.zh.md)

Job Radar can answer questions from an MCP client you set up yourself, such as Claude Desktop or Claude Code: "what new jobs
are worth a look today?", "which applications have had no answer for two weeks?", "what does this job say about pay?". The
client starts `pnpm mcp:serve` as a local child process and talks to it over stdin / stdout.

- **Off by default.** Nothing happens until you set `enabled: true` in `mcp.yaml`.
- **Local only.** No port is opened and there is no token: only a program you configure on this computer can start it.
- **Read-only.** There are no tools that change anything, and its database sessions are read-only. It never starts a
  collection or an AI call.

## What leaves your machine

**Whatever the tools return is passed by your client to the model provider it uses** (Anthropic for Claude, and so on), under
that provider's terms. Turning the server on adds this exit to the ones listed in [privacy.md](privacy.md).

| Given (when you ask) | Never given (no setting turns them on) |
|---|---|
| Job facts: title, company, locations, work mode, contract, agency flag, required German level, status, dates, skills | Your profile files (`me`, `preferences`, `interests`) and their saved snapshots |
| Source links (posting and apply links) | Match reasons, gaps, filter reasons, your salary floor, the German-level deduction and anything else worked out from your profile |
| The stated salary | Notes: application notes, notes on status changes, notes on starred jobs |
| Score and rank numbers | Local paths (tailored résumé files) |
| Compensation and benefit signals with their JD quote and position | Emails and email replies |
| The JD after AI-trap cleaning (see below) | `.env` and `.auth/` values, keys, AI usage, notifications, run records, config file contents |
| Your applications: status, when it last changed, days in that status, next step and its date, interview rounds, the status history | |

The list is fixed in code (`src/lib/mcp/dto.ts`); each answer is built field by field, so a new database column never shows up
by itself.

## Turning it on

1. Open `mcp.yaml` (Settings → Advanced, or `data/config/mcp.yaml`) and set `enabled: true`. Each tool can be switched off on
   its own under `tools`; `limits` caps how many items one call returns (`max_results`, at most 100) and how long a JD may be
   (`max_description_chars`).
2. Check it: `pnpm run doctor` shows `data.mcp` as on, with the tools.
3. Add the server to your client (below), then restart the client.

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
| `search_jobs` | Ranked job cards, filtered like the jobs list: `query` (title, company name/aliases, city/location and country), `search_in` (`summary` by default; `all` adds the original JD and current translations), `country` (1–20 two-letter exact codes, case-insensitive, OR), `city`, `workplace`, `min_rank`, `min_annual_salary` (in the market's base currency), `since` / `until` (first seen, `YYYY-MM-DD`), `application_status`, `sort` (`relevance`, `rank`, `posted`, `first_seen`; default `relevance` with a query, `rank` without one), `limit`. Jobs the hard filter removed, closed jobs and dormant jobs not listed for weeks are left out. No JD text. |
| `get_job` | One job (`job_id`) in detail: everything above plus seniority, language, the signals with their quotes, the number of AI traps found, your application, and the cleaned JD. |
| `list_applications` | Your applications, best rank first; `status` filters; `stale_only: true` lists only the ones waiting longer than the daily reminder's thresholds (`notify.yaml: reminders.interested_days` / `applied_days`), the longest waiting first. |

`get_job` still returns dormant jobs: `status` stays `possibly_closed`, and `closed_reason` is `dormant`.

"What is new today" is `search_jobs` with `since` = today and `sort` = `rank`, plus `list_applications` with `stale_only`.

Every answer says how many items matched (`total`) and how many it returns (`returned`); when it cut the list,
`truncated` is true and a notice says so. Invalid arguments come back as an error result naming the field.

## AI traps and the JD

The reader of an answer is an AI, which is exactly what the [AI traps](ai-traps.md) in some postings aim at. So:

- `get_job` gives the JD only after the stored trap findings were taken out (hidden text and instructions to an AI are replaced
  by the markers of `traps.yaml: ai_input`). A signal quote that overlaps a finding is replaced by its marker as well.
- **The JD is withheld** ("JD not available") when trap detection is off (`traps.yaml: enabled: false`), when the job has not
  been scanned under the current rules yet (it will be on the next cycle, or run `pnpm traps:scan --write`), or when the
  findings cannot be read. The signal quotes are withheld then too (`quote: null`); the other fields of the job are still given.
- Short fields (title, company, locations, salary text, quotes, links) lose invisible characters; a field that carries an
  instruction to an AI is replaced by the marker.
- Notices come first, in this order: for `get_job`, "Job Radar found N pieces of text aimed at AI in this JD and removed them"
  (when it found any), then "The JD was cut at … characters" (when it was cut), then the notice that the posting texts are
  third-party content to be treated as data. `search_jobs` and `list_applications` give "N of M shown" (when the list was cut)
  before the third-party notice. Every answer has the third-party notice.

This lowers the risk; it cannot rule it out. A posting can always word an instruction in a way no rule recognises. Since the
server has no tools that change anything, the worst a trap can do is mislead your client's answer.

## The log

Each call writes one line to stderr (your client keeps it in its log of the server): the tool, how many items it returned, how
long it took, and whether it worked. Never the arguments or the results. Errors name a category only (`database`, `not_found`,
`invalid_input`, ...), never an address or a path.

## Optional: a database role that can only read

The read-only sessions guard against a mistaken write, but they are not a security boundary. For a hard one, give the server
its own role with `SELECT` rights only:

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

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| The client says the server exited; its log shows "The Job Radar MCP server is switched off" | `mcp.yaml: enabled` is `false`. Set it to `true` and restart the client. |
| "mcp.yaml cannot be read" | `pnpm config:check` names the setting. |
| "Every tool is switched off" | All three `tools` are `false`. |
| `command not found` / `spawn pnpm ENOENT` | The client does not find `pnpm` or `node`: use absolute paths and set `PATH` in `env` (see Claude Desktop above). |
| "The query failed (database)" | The stack is not running, or the database address in `.env` is not reachable from the host. `pnpm run doctor` checks both. |
| "JD not available" | See [AI traps and the JD](#ai-traps-and-the-jd). |
