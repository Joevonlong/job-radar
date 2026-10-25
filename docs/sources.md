# Source registry: one file for every collection source

What you want is to know exactly which sources exist, which are healthy and which are not, with no black box. All collection sources now live in one file: `data/config/sources.yaml`. The `/sources/registry` page and the `pnpm sources:list` command read it, plus the health records in the database.

## 1. Three copies, which one wins

| Copy | What it is | Who changes it |
|---|---|---|
| `data/config/sources.yaml` | **The truth.** Switches, parameters and budgets for every channel, plus the company ATS boards to collect | You, the web UI (the "Sources" tab of the settings page, the registry page), an agent |
| DB table `source_registry` | A **mirror** of the file: one row per entry; entries deleted from the file stay, marked `in_config = false` | Runner start and config hot-reload, after every web write to the file, when the registry page finds it out of sync, `pnpm sources:list --sync` |
| `/sources/registry` page | File + health data (`channels`, `runs`, `ats_boards`, `raw_postings`) | Read-only view; switches and edits are written back to the file |

Every change made in the web UI is written back to `sources.yaml` (comments preserved) and then synced to the database immediately.

## 2. File structure

```
top         total paid budget, circuit breaker, concurrency, HTTP, size of the "Test" button (shared by all channels)
linkedin    LinkedIn cascade order and the four LinkedIn channels
jobspy      jobspy sidecar (shared by linkedin-guest, indeed, jobspy-google); proxies may contain credentials
sources     other channels: job boards, search APIs, company ATS, board discovery, Gmail alert emails
ats_boards  company ATS boards to collect: name, ats, token, enabled, optional region
registry    stats window, status thresholds, import size limit, "open board" URL templates for the registry page
```

Entry ids: a channel is its channel name (`greenhouse`, `gmail-alerts`, `linkedin-session:recommended`); a company is `board:<ats>:<token>` (`board:greenhouse:celonis`).

Keys under `registry:` can only be changed in the YAML: `window_days` (stats window, 7 days), `board_failing_after` (how many consecutive failures count as failing, 2), `board_stale_hours` (how long without a check counts as degraded, 48), `import_max_bytes`, `board_page_urls`, and optionally `candidates_page_size` (how many "discovered boards" are listed at once; 10 if omitted; deliberately left out of the shipped file, because a default written there would be carried into the file on every save).

## 3. How the seven statuses are decided

| Status | Meaning |
|---|---|
| OK | The latest run succeeded; for a company, the latest check succeeded and was not long ago |
| Degraded | Recent request failures, or probing after the circuit breaker opened; **the last several runs were all "skipped"** (no usable channel in the cascade, or budget used up; the reason reads "skipped in the last N cycles: <reason>", even if it succeeded earlier); for a company, the latest check failed (count below the threshold) or it has not been checked for too long |
| Failing | The latest run failed or the circuit breaker is open; for a company, consecutive failures reached `board_failing_after` |
| Disabled | The switch is off; for a company, its ATS channel is off |
| Not configured | Enabled but missing a key / not logged in (the page shows only the variable name, never the value) |
| Never run | The channel has no run records yet; the company has not been checked yet |
| Standby | A later channel in the LinkedIn cascade: enabled, but a channel ahead of it is available so it never got its turn ("cascade fallback: does not run while earlier channels are available"); sorted after "OK" |

A channel's status is the same result as the channel card on the `/sources` overview page. For companies the first match wins, in this order: disabled -> never run -> consecutive failures reached the threshold (failing) -> latest check failed (degraded) -> not checked for too long (degraded) -> OK. Every row has a one-line reason; hover for the full text.

### How jobs get marked possibly closed

"Possibly closed" is a hint based on time, not proof, and it is judged per channel, not per search query:

- A job becomes possibly closed when no source has returned it for `possibly_closed_after_days` days (7 by default) **and** each channel it came from has had at least one successful run that started after those days had passed. Runs that failed, were skipped or were interrupted do not count, so a channel that was down never closes its jobs.
- An already-stored job still listed by a company ATS board counts as seen even when it falls beyond `max_results`.
  The cap alone does not make it possibly closed.
- A search only returns postings inside its time window (`window_hours`; JSearch maps it onto its supported windows: today, 3 days, week, month; anything above a week becomes a month), so a query that does not return a job says nothing about whether it is closed. That is why a single query's result never marks a job by itself.
- The evidence is the link check that follows: it tries each source link of the job. A live page on any of them brings the job back to active; it is closed only when every link checked returns 404 or 410. Anything else leaves the mark as it is.
- A job that is seen again by any source becomes active again, with two exceptions: a mark that came from a "no longer accepting applications" sentence on the posting stays, and so does a closure you made yourself.

### Company ATS boards

For company ATS boards, `max_results` is the maximum number of postings stored per board per run,
after the title prefilter. Matching postings are taken in the board's list order up to that cap.
Stored postings beyond the cap are refreshed as seen while the board still lists them, including
when the board reports that its list is unchanged. Their saved title and description are not updated
until they are back within the cap. Postings beyond the cap that have never been stored are not added.
The registry's "kept" count means postings that passed the title prefilter and fit within the cap.

A stored posting dropped by the title prefilter does **not** count as seen.
After you narrow your keywords, it ages out as usual unless another source sees it.

For SmartRecruiters only, a failing detail request no longer fails the board. A stored posting keeps its saved version
and is refreshed as seen; a new posting is not stored and is retried in later sweeps, ahead of postings whose
details already failed before. After
`sources.smartrecruiters.max_consecutive_detail_failures` failures in a row (default 3), or a host-level refusal
(blocked, login/auth expired, rate limit, or budget), the board's remaining details are skipped for that sweep.

## 4. What you can do on the page

- View: the summary bar (click a block to show only that status), type / status / search filters (all kept in the URL, so they survive a refresh); channels are grouped, companies show failing ones first by default.
- Switch: the enable switch of channels and companies only changes the `enabled` line in the file. `linkedin-session:recommended` ("recommended for you", read once a day) requires `linkedin-session` to be enabled first: while it is off this switch is greyed out, with the reason on hover, and does not pretend to be enabled.
- Edit parameters: "Edit parameters" on a channel row jumps to `/settings?tab=channels&section=<channel id>`.
- Companies: add, edit, delete (confirmed before deleting; postings already collected are not affected); "Open board" shows the careers page in a new window.
- Discovered boards: lower on the page, first one page is listed (10 by default) with the total count stated, "Show N more" expands; the search box and the ATS and type filters apply to it too, the status filter does not (the page says so). "Add" writes it into `ats_boards`; after "Ignore" it no longer appears.
- Channel details: circuit-breaker state, consecutive failures, usage this month, and the "Collect now" and "Test" buttons.
- On a phone (narrow screen) the two tables become cards, and "Details" expands the rest.

### Import and export

- Export YAML: the file as is (with comments), file name `sources-20261008-1402.yaml`. Export JSON: the validated values. Both replace the credentials in URLs under `jobspy.proxies` with `***`.
- Import: upload or paste YAML / JSON, click "Preview" to see the diff (channels enabled / disabled, parameter changes, companies added / removed / modified, other settings), then "Apply". The server re-validates on apply; if the file was changed after the preview it refuses, so preview again.
- Two modes: **replace the whole file** (must be a complete, valid sources.yaml) and **merge ATS companies only** (the file has an `ats_boards` list; adds or updates, never deletes).
- `jobspy.proxies` always keeps its current value; import cannot change it. An exported JSON can be imported back whole as is, with no diff.
- Export the current file before importing; if something goes wrong you can import it back.
- When validation fails, errors are written in the UI language and name companies as "name (ats/token)", not by list index; a YAML syntax error reports the line and column once.
- When "replace the whole file" removes a company, the group comments above the other companies stay where they are; the removed company's own group comment moves to the company after it.
- When `sources.yaml` cannot be read: the table shows the database mirror (possibly stale; its status is coarser and follows only the last run: failed is Failing, partial or cut short is Degraded, anything else OK), switches and editing are disabled, but export YAML and import still work; use import to replace the whole file and repair it.

## 5. Command line

```
pnpm sources:list [--type channel|ats_board] [--status failing ...] [--all] [--json] [--sync] [--strict] [--lang en|zh]
```

Prints all sources, their status and the reason (the table language follows `cli.locale`; override it with `--lang en|zh`). `--json` outputs code values: `status` (`ok` / `degraded` / ...), `lastRunResult` (`succeeded` / `failed` / `skipped`; for companies `ok` / `not_modified` / `error`), `reasons` (`[{ key, values }]`); "last run" and "last success" are both finish times. `--status` can be repeated; `--all` includes entries that were removed from the file; `--sync` syncs the file into the database first; `--strict` exits with code 1 if any enabled source is "failing". When the database is unreachable it lists only the entries in the file (status "unknown").

`sources.registry` in `pnpm run doctor`: warn when an enabled source is failing or the mirror is behind; fail when `sources.yaml` cannot be read.

### Query rotation

`collect.query_rotation` defaults to `true`. Each cycle starts with queries that have never had a turn on the unit's
starting channel, then those whose last turn was longest ago. Ties keep `search.yaml` order. Set it to `false` under
`collect` in your `data/config/sources.yaml` to use config order every cycle; remove the key before rolling back to code
that does not know it. Adding a query or changing its keywords, location or remote scope gives it a new id and puts it
first; removing a query leaves it out. Reordering queries only changes ties.

A turn is any run except a skipped run with no postings, no recorded usage and no cost. Failures, cancellations and
unfinished runs count, including orphaned runs later marked failed. A budget stop that spent quota or money counts even
when it returned nothing, including an empty Apify sub-run that paid a start fee. A refusal before any request and the
"no available channel" summary row do not advance the order. History has no age cutoff.

The starting channel is the first currently available channel in the selected cascade, or the single channel of an
independent unit. With an unchanged set of N queries and the same starting channel, at most N−1 other turns fall between
two turns of one query. Only that starting channel has this fairness guarantee; later cascade channels serve the remaining
queries. When paid channels run out, the guest can become the start and uses its own history. A unit that can run nothing
keeps its order. Single-query scan units are unaffected. Manual runs and catch-up cycles also advance rotation; a catch-up
uses the base window of the scheduled cycle it replaces (`windowKind`). The channel's "Test" button does not write runs
and does not affect rotation.

Each completed unit emits a `query rotation` log and a `steps[collect].result.rotation` summary, stored in the cycle's
`cycles.summary_json.steps` entry whose `name` is `collect`. They show the starting channel (`sortChannel`), query count,
served/failed outcomes (`reached`), never-run count, oldest known wait and query, and largest requested window
(`maxWindowHours`); the log also includes `notReached`. Unknown waits are null. Windows stay at their configured base
values, and `stretched` and `capped` are both 0. Dry runs use config order and mark `historyUnavailable: true`; the CLI says
so. A history read failure warns once and uses the same fallback. Having no available start channel does not itself make
history unavailable: if the history read succeeded, `historyUnavailable` is false, `neverRun` is 0 and the oldest wait
is null. Aborted or throwing units have no rotation summary.

For the individual attempts, inspect the `runs` table in PostgreSQL (or `pnpm db:studio`):

- `usage_units`: usage booked to the channel budget, such as JSearch requests or Bright Data / Apify records. Check `cost`
  too: an empty Apify run can have zero usage units but a positive start fee.
- `window_hours`: the window actually requested from the channel; null for a "no available channel" summary row.
- `window_extended`: false for all attempts in this version; rotation does not extend windows.

Two limits of the recorded history remain:

- LinkedIn session's daily page counter is separate from the channel budget and is not in `usage_units`. If the page limit
  stops a query after loading pages but before retaining any postings, its empty, unspent skip does not count as a turn.
- JSearch searches only the first `keywords_per_query` keywords in a group. Reordering keywords within that group keeps the
  query id, so its history can describe a different prefix of keywords.

Board discovery (Tavily and Brave) uses the same `collect.query_rotation` switch, rotating searches inside each channel.
Its per-query turns live in `runtime_state`, not `runs`, and all turns in one run share a timestamp. It guarantees a turn
at least every `ceil(N / cap)` runs when the config and cap stay unchanged, rotation is on, turns are saved each time,
the clock does not move backwards, and each selected batch completes without a budget/quota stop, fatal error or
cancellation; interval skips do not count. It does not provide the N−1 guarantee above. Cancellation observed before
discovery starts writing leaves no turns, candidates or run marker; cancellation after writing starts does not undo
earlier writes. Dry runs and the "Test" button keep config order without reading or writing turns. See
[Tavily discovery](tavily.md#how-it-works) for the details, including repeated cancellations.

## 6. Handling common failures

| You see | What to do |
|---|---|
| SmartRecruiters detail request fails | The board stays OK; the `ats board details missing` log line shows failed and skipped counts. Stored jobs keep their saved version and are refreshed as seen; new jobs arrive in later sweeps. For persistent refusals, check the board's careers page and your network, or increase `sources.smartrecruiters.throttle` delays to lower the load. See [Company ATS boards](#company-ats-boards) |
| Company "N consecutive failures: board does not exist (404)" | The token is wrong or the company changed ATS: click "Open board" to look at the careers page, fix the token under "Edit", or "Delete" |
| Company "not checked for N hours" | Its ATS channel is off or the breaker is open, or the runner is not running; look at the channel row |
| Channel "breaker open until ..." | Consecutive failures reached `circuit_breaker.failures`; it tries once automatically when the cooldown expires; expand "Details" for the latest error code; being blocked usually means waiting or switching channels |
| A run "interrupted: <error>" (in amber) | A search that reads several pages stopped part way (network error, blocked, budget used up). The postings read before the stop are kept, but the run counts as a failure: it moves the channel's breaker (except when the budget stopped it: running out of budget never opens the breaker), it is listed under failed sources, and its postings are not used to mark jobs as possibly closed. Postings from an interrupted run may lack their detail page; it is fetched in a later cycle. A run is only "interrupted" if at least one posting could be handed over before the failure; with none it is an ordinary failure (for example LinkedIn's result list was read but every card still needs its posting page). The LinkedIn session channel is covered too: if a result page or a posting page fails part way (network error, HTTP 429, or a login or verification page), it loads no more pages in that query and keeps only the postings already read or needing no page load (already stored ones, or the list cards when `fetch_details` is off); cards that still need their posting page are left out and listed again by the next run. Reaching the daily page limit part way is a budget stop, as with JSearch: no more pages are loaded, the postings read and those needing no page load are stored, and the run is "skipped", not "interrupted" (no failure, the breaker is left alone). That skipped run is not used to mark jobs as possibly closed; another complete run of the same channel still counts (even an earlier query in the same cycle), because the mark is judged per channel and by time, not per query (see [How jobs get marked possibly closed](#how-jobs-get-marked-possibly-closed)). The same query then goes to the next channel of the cascade. See [LinkedIn session](linkedin-session.md#when-the-daily-page-limit-is-reached) |
| "Missing TAVILY_API_KEY" and similar | Put this variable in `.env` (the page only tells you the name), or turn the channel off |
| "LinkedIn not logged in / login expired" | Log in again, see [LinkedIn session](linkedin-session.md) |
| JSearch run "skipped" with postings, or "interrupted: <error>" | With `keywords_per_query` above 1 a JSearch query makes one request per keyword. If a later keyword's request fails after earlier keywords delivered postings, those postings are kept and the run is "interrupted" (a failure; with nothing to keep it is an ordinary failure). If a later keyword is refused before its request because the monthly limit or the even-spread share is used up, the postings read so far are stored and the run is "skipped": it counts as a budget skip, adds no failure and leaves the breaker alone, and it is not used to mark jobs as possibly closed. See [JSearch](jsearch.md) |
| "Mirror out of sync" at the top of the page | The runner fixes it on start or config hot-reload; or run `pnpm sources:list --sync` |

## Arbeitnow

Arbeitnow (`arbeitnow`) is a free public job board API: no key, no login. It is one of the Germany pack's local channels and is
on in the shipped `sources.yaml` (`markets: [DE]`); an existing installation gets the same block from the config update
(`pnpm config:migrate`), with the title prefilter terms copied from its `greenhouse` block.

- **What a run reads.** The API takes no keywords or places. Each run reads the newest pages of the whole board (at most
  `max_pages`, 8 by default, 1 to 3 seconds apart), keeps the postings inside the cycle's look-back window and stores only the
  titles that pass `title_prefilter`, as for the company career boards: a search keyword or an `include_terms` entry, or a
  watched company; `exclude_terms` drops student and intern jobs. About half of the board is outside Germany: the location
  filter drops what does not fit your market, and a job that also comes from a company's ATS board is merged into one.
- **What a posting has.** Title, company, one free-text location, a remote flag, free-text job types (kept as the contract
  hint), tags and an HTML description, which the trap scan reads for hidden text ([ai-traps.md](ai-traps.md)). There is no
  salary field (salaries are read from the text). The job's link goes to its page on arbeitnow.com.
- **Terms.** The API is offered as is and can be withdrawn at any time; a platform that uses it links back to arbeitnow.com
  (Arbeitnow terms, section 11). The Arbeitnow card on `/sources` carries that link. If you use your instance commercially or
  show the jobs to other people, read the [Arbeitnow terms](https://www.arbeitnow.com/terms) yourself; don't mirror or
  republish the collected data (section 2.1.5).
- **Limits.** The pages are cached one by one and are not sorted by date, so a posting missed in one cycle is usually picked up
  in the next. The rate-limit headers of the responses are cached too and are not used. A 429 is retried after its
  `Retry-After`; a 403 or a 410 (the API was withdrawn) counts as blocked and opens the channel's circuit breaker, the other
  channels keep running.
- **Settings**: `base_url`, `user_agent`, `max_pages`, `max_results`, `throttle` and `title_prefilter` under
  `sources.arbeitnow` (also on the settings page). Switch it off with `enabled: false` or the switch on `/sources/registry`.

## Scraping

Not every channel uses an official API. Some read public web pages or unofficial endpoints, and some act as your own
logged-in account. The terms of service of most job sites forbid automated access, so these channels are **off by default
for a new installation** and need your explicit consent to switch on.

| Kind | Channels | Default | Risk |
|---|---|---|---|
| Scraping | LinkedIn guest search (`linkedin-guest`), Indeed (`indeed`), StepStone (`stepstone`), XING (`xing`), Google Jobs via the sidecar (`jobspy-google`) | off | the site's terms may forbid it; your IP address can be rate limited or blocked |
| Account automation | LinkedIn logged-in session (`linkedin-session`, `linkedin-session:recommended`) | off | uses your own account; the account can be restricted or banned |
| Official APIs and public company feeds | Arbeitsagentur, [Arbeitnow](#arbeitnow), Greenhouse, Lever, Ashby, Personio, SmartRecruiters (on); JSearch, Gmail alerts, Tavily, Brave (need your key or account) | on, or off until you add a key | follow the provider's own terms and quotas |
| Paid scraping services | Bright Data, Apify | on, but nothing happens without your token | a service scrapes for you; **this does not remove the terms-of-service risk**, which stays with you |

How to switch one on:

- **Setup wizard, Sources step.** Scraping and account channels are never pre-ticked, not even the ones your market pack lists
  as local. Ticking one shows a notice and a confirmation box you must tick before the step can be saved. With `pnpm run setup
  --answers`, set `sources.acknowledge_scraping: true` (see [setup.md](setup.md#the-answers-file)).
- **`/sources/registry`.** Turning the switch of such a channel on opens a dialog with the same notice; the change is written only
  after you confirm. Turning it off needs no confirmation. The server refuses to switch one on without the confirmation. An import file that switches such a channel on shows the same notice in its preview and needs a confirmation box ticked before it can be applied.
- **Settings page or the YAML.** Setting `enabled: true` there is taken as an explicit decision: the settings form shows the
  notice next to the switch but does not block you. The "Turn them on" button on `/me` (after changing the market) skips these
  channels and tells you to do it on the Sources page.

Existing installations keep their `data/config/sources.yaml` exactly as it is; only a new installation starts with these channels
off. `jobspy.linkedin_fetch_description` (one more request per LinkedIn job to read the full description) is off by default as
well.

If you switch scraping channels on: read the terms of every site, keep volumes low (few keywords, few cities, the
default schedule), do not republish collected data, and prefer official APIs, company career boards and your own job-alert
emails. You are responsible for how you use them.

### Disclaimer

Some sources read public web pages or unofficial endpoints. Job boards' terms of service may forbid automated access,
and their pages change without notice. Job Radar is a personal tool: it throttles requests, never tries to get past a
login wall, CAPTCHA or verification page, and stops using a source that keeps failing. You are responsible for how you
use it: check the terms of every site you enable, keep volumes low, prefer official APIs and your own alert emails where
you can, and don't republish collected data. The maintainers give no warranty and accept no liability for your use of
third-party services. Paid services such as Bright Data or Apify scrape for you but don't remove the terms-of-service
risk.

Job Radar is an independent project. It is not affiliated with, endorsed by or sponsored by any job board, employer or
service it can talk to; all trademarks belong to their owners (see [NOTICE](../NOTICE)). The test fixtures and demo data
are synthetic: employers, ids, links, contacts and ad texts are invented.
