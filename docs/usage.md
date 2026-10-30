# Daily Usage Guide

Job Radar never deletes any job, posting, score, translation or analysis automatically.

For first-time use, go through the setup wizard (`/setup`, see [setup.md](setup.md)); to adjust what you get afterwards, use the tuning guide [`getting-started.html`](getting-started.html).

Once deployed, this is how you use Job Radar day to day: how to start and open it, how to tell whether it is healthy, and where to read jobs and JDs. For first deployment, upgrades and rollbacks see [`deploy.md`](deploy.md); for the host machine's own setup see [`host-setup.md`](host-setup.md).

Commands run in the project directory by default (the directory containing `package.json`, `compose.yaml`, `config/` and `data/`).

## 1. Starting and accessing

### It runs on its own

The whole system is 4 Docker containers (`db` database, `web` web app, `runner` scheduled collection, `jobspy` scraping helper), plus an `ai-worker` on the host (managed by launchd on macOS or a systemd user unit on Linux) (it handles AI scoring, translation and Telegram pushes). All of them restart automatically: if Docker starts at boot or login, the containers come back by themselves, so **you normally never start anything by hand**.

Processing cycles run automatically per `data/config/schedule.yaml` (in its `timezone`):

| Cycle | Time |
|---|---|
| Morning | Weekdays 07:00 |
| Evening | Weekdays 17:00 |
| Weekend | Saturday and Sunday 09:00 |

If the host was off or asleep and missed a cycle, the runner runs one catch-up cycle on startup (`catch_up`). A
"Collect now" of one channel does not count as the slot's cycle. A scheduled cycle that starts while such a cycle of
only some channels is running waits for it and then runs; one that finds a cycle of every channel running is skipped
(see "Overlapping cycles" in [configuration.md](configuration.md)).

### Starting and stopping by hand

| What you want | Command |
|---|---|
| Start (or rebuild after code changes) | `pnpm stack:up` (= `docker compose up -d --build`) |
| Stop (data is kept) | `pnpm stack:down` |
| Restart one service | `docker compose restart runner` (or `web`, etc.) |
| See the state of the four containers | `docker compose ps` |
| Upgrade to the latest release | Run `scripts/ops/deploy.sh` (see `deploy.md`) |
| ai-worker is not running | Run `scripts/ops/install-ai-worker.sh` |

Never run `docker compose down -v`: `-v` deletes the database volume.

### Opening the web app

| Where | Address |
|---|---|
| On this machine | http://127.0.0.1:3000 |
| Phone / other devices (same Tailscale account) | `public_base_url` in `data/config/notify.yaml` (`https://<machine>.<tailnet>.ts.net`) |

The web app is reachable only on this machine and inside your tailnet, not on the public internet. If you set a web
password (see [configuration.md](configuration.md#web-access-optional-password-bind-address-and-port)), other devices
show a sign-in page once; the session lasts 30 days, and "Sign out" is at the bottom of the sidebar (in the ☰ menu on a
phone). The browser on this machine itself needs no password. On your phone, open the Tailscale app and connect first, then open this address. The links in Telegram messages point to this address too.

## 2. Monitoring: how to know it is healthy

### One command for a full check-up: `pnpm run doctor`

```bash
pnpm run doctor
```

It checks, item by item, the containers, the database, the runner and ai-worker heartbeats, claude / codex login, Telegram, Tailscale, backups, disk, each channel's key and budget, the previous and next cycle, and the AI backlog: about 40 items, each marked ✅ / ⚠️ / ❌, with a "what to do" under every ⚠️ and ❌. The last line is a summary:

```
Total: 39 ✅  3 ⚠️   0 ❌  —  some things need attention (exit code 1)
```

- All ✅ (exit code 0): everything is fine.
- Any ⚠️ (exit code 1): it works, but something deserves attention, for example a channel is missing a key or disk space is low.
- Any ❌ (exit code 2): something is broken; follow the "what to do".

Always write `pnpm run doctor`; plain `pnpm doctor` is a different built-in pnpm command. doctor is read-only: it sends no messages, calls no AI and costs nothing. Section 3 of `deploy.md` explains what each item means.

### In the web app: the `/sources` page

Open http://127.0.0.1:3000/sources: each channel gets a compact card (status light, name, a big number for jobs fetched this cycle, the trend, health squares for the last few cycles, and a one-line status; with only one cycle recorded the trend says "1 cycle", and a channel that has never run says "no records"). Click "Details" at the bottom of a card to expand it: the collect-now / test buttons, this month's usage and budget, the count and errors of the last 10 runs, which channel most recently served the LinkedIn cascade, this month's AI usage, the runner heartbeat, and the AI worker card (heartbeat, queue, a hint when the profile is incomplete). The Today page `/` also shows, at the top, the count per source and the number of failures this cycle.

### You find out without looking: Telegram alerts

When something goes wrong the runner proactively sends a Telegram message: a channel's circuit breaker tripped, the LinkedIn session expired or hit a verification page, budget at 80% / 100%, all AI providers failed, a cycle did not finish, ai-worker went offline, a backup failed. The same kind of alert is sent at most once per 24 hours. After every cycle there is also a summary message (new jobs, jobs passing filters, qualified jobs, failed sources); **receiving the summary means that cycle finished**.

### A quick glance

```bash
curl -s 127.0.0.1:3000/api/health          # web and database: {"status":"ok",...}
docker compose ps                          # all four services should be Up (healthy)
```

### Reading logs

```bash
docker compose logs -f --tail 100 runner              # collection, processing cycles, push queue
docker compose logs --tail 100 web                    # web app
tail -f data/logs/ai-worker.out.log    # ai-worker: scoring, translation, pushes
tail -f data/logs/ai-worker.err.log    # ai-worker errors
```

## 3. Reading jobs: the web board

The web app is the main entry point. Its pages:

| Page | Use |
|---|---|
| `/` Today | New jobs of this cycle and today, ordered by rank value; the top shows the count per source; you can switch between saved views |
| `/companies` Companies | Companies with open jobs: search names, sort by job count, top score or latest first seen, watch or unwatch, and open the profile's company exclusions |
| `/favorites` Favorites | All jobs you starred with ⭐ (including closed, hard-filtered and ignored ones, which are still marked in the row), by default ordered by when you favorited them, or by rank value; each row can carry a short note (up to 200 characters, saved with Enter or on leaving the field, Esc cancels); the un-favorite toast has "Undo" (the note and favorite time are restored together). Favorites and application status are independent: a job can be both "applied" and favorited, and favoriting neither puts it on the board nor triggers the "interested for more than N days" reminder. The number in the sidebar is the total number of favorites |
| `/jobs` All jobs | Sortable by clicking the Rank value, Salary / yr and Freshness column heads (click again to flip the direction; see "Sorting the list"); precise search + filters (score, salary, high-pay signal, source, city, country, company, workplace, job status, German requirement, contract, application status, date; source, city, country, company, workplace, contract, job status and application status are **multi-select**); hard-filtered jobs are hidden by default and can be shown ("Filtered out only", `filteredOnly=true`, lists just them: the filtered-out numbers on /insights open it; not stored in a view); the current filters can be saved as a view ("favorites only" shows just favorited jobs, is `fav=true` in the URL, and is **not** stored in a view; "Unseen only" is `unseen=true` and is not stored either); unseen jobs are bold with a dot, "N unseen · Mark all as seen" next to the count (see "Seen and unseen jobs"); the **Current / Archive (N) / All** switch selects the scope, with reasons and last-listed sorting in the archive (see "Closed jobs and the archive"); with the ghost job check on, a "Ghost jobs" filter (All / Suspected only / Hide likely) and a mark under the score (see [ghost-jobs.md](ghost-jobs.md)) |
| `/jobs/<id>` Job detail | **The original JD and its translation into your configured language**, the AI match reasons and gaps, compensation and benefit signals, the German requirement, all source links and "View original posting", "Mark as applied", the application status, notes, "Tailor resume"; "Mark as closed" (with an optional note) / "Reopen", and for a closed job why it is closed and when its posting was last checked |
| `/pipeline` Application board | Cards show three dates: Applied is the first time marked applied (not necessarily the actual submission time; missing history says "Not recorded"), Since is when the current status began, and Next step is the planned calendar day. Applied is hidden in New / Interested / Preparing unless recorded. Applied and Since use the display time zone; Undo restores both dates. Compact and Comfortable show the same fields; the toolbar density choice is remembered in this browser. Tab navigation reveals the whole focused card; clicking a visible title opens its drawer even when the rest of the card is below the column edge. New / Interested / Preparing / Applied / Interviewing / Offer / Closed; the bar at the top of each column is that column's share of the pipeline; "in the pipeline" has a single definition: applications that have not ended (including the "New" column), and the page title's "N jobs in the pipeline", the column shares and the sidebar's "Applications N" all count the same set; the progress bar on a card is how many days it has stayed in the current status (thresholds come from `reminders` in `notify.yaml`, the part beyond the threshold turns red; the screen-reader scale is the threshold itself, and the days over are stated in the reading); the board fits the remaining screen height, with fixed column heads and independent card scrolling (the three Closed groups share one scroll area); the seven columns are equal width, with horizontal scrolling inside the board and Previous column / Next column buttons on desktop; short screens keep the configured board height while the heading and filters scroll within the main area; dropping into Closed opens it and brings the card into view; the "New" column shows jobs that have an application record but are not yet decided (only a note written, a resume attached, or set back to "New"); change status by dragging or with the "⋯ Move to…" menu at the top right of the card, and the toast after a change has "Undo" (undo removes that step from the timeline and restores the original timer, without adding two extra entries); the "Closed" column first shows the counts of rejected / I withdrew / ignored, and opens up to show the cards; keyboard users: Tab to the drag handle on a card, Space or Enter to pick it up, arrow keys to change column, Space or Enter to drop, Esc to cancel (screen readers announce the current column), or use the "⋯ Move to…" menu |
| `/sources/ai-usage` AI usage | For every AI call, the model, tokens, duration, equivalent API cost and actual spend; time range, filters, a per-day chart, three breakdown tables, the call details, CSV export (see `ai-usage.md`) |
| `/insights` Insights | New per day, source breakdown, cities, salary disclosure rate, signal distribution, application funnel (7 / 30 / 90 days) |
| `/sources` Sources | See the previous section |
| `/me` My profile | Edit `me.yaml` / `preferences.yaml` (the summary and skills drive AI scoring) |
| `/interests` Interests | Signal words, watched companies, approving / rejecting the AI's weekly learning suggestions |
| `/settings` Settings | Form editing of all configuration; the "Manual actions" tab has "Run a cycle now" and "Re-score stale scores" |

### Reading a JD

1. Open `/` (today's jobs) or `/jobs` (all jobs) and click a job title to enter the detail page.
2. The JD block on the detail page is the original text and can be switched to the translation; for one not yet translated, click "Translate" and ai-worker finishes within a few dozen seconds (the page shows progress).
3. To apply: click "View original posting" to open the original link (for company ATS sources this opens the job page rather than the application form, falling back to the application link only when there is no job-page link; for aggregator sources it uses the direct employer link it picked; it only opens the link and does **not** automatically mark the job as applied); after you have actually submitted, click "Mark as applied" (with undo); or click "Tailor resume" to export the JD and get the resume-kit command (see `resume-kit.md`).

Shortcuts: `⌘K` (`Ctrl K` on Windows / Linux) opens Jump to for pages and jobs; in lists `j` / `k` move up and down, `s` marks as interested (👍), `x` ignores, `f` favorites / un-favorites (★), `u` switches the row between seen and unseen, `c` marks the job closed (or reopens it). The "Favorite" button on the detail page (the star in the bottom bar on phones) works too. Icon conventions: ★ / ⭐ only ever means favorite, 👍 is "interested" (one status in the application pipeline), 🏅 is the T3 "competitive" badge (T1 to T4 are the four compensation-signal categories: stated amount, equity, qualitative pay wording, bonus; see [signals.md](signals.md)), 📌 is the default marker of a view.

### Searching jobs

The **Jobs** search box filters the list. **Jump to ⌘K** (Ctrl K on Windows / Linux) opens pages or a few matching jobs; its last item opens all results in the job list. Both use the same default matching rules and relevance order.

By default, search checks titles, company names and aliases, cities, location labels and countries. It does **not** search job descriptions. Terms are combined with AND and may match different fields. Short Latin terms match whole words (`AI` does not match `Maintenance` or `Airbus`); longer terms allow word prefixes. `C++`, `C#` and `.NET` keep their symbols. Double quotes require a continuous phrase in one field: `"product manager"` does not match `Product Marketing Manager` or words split across title and description. Matching normalizes letter case and full-width characters. Punctuation-only queries show “No searchable terms”; excess terms are ignored with a notice. Limits are set in `job-search.yaml` (see [configuration.md](configuration.md)).

Country names such as `Germany`, `Deutschland` and `德国` match the country code and literal text. Unambiguous codes such as `DE` / `de` match only the country; quote `"de"` to search the literal word. Ambiguous codes such as `AI`, `IT` and `US` stay ordinary text. The **Country** multi-select always filters the stored country code exactly, without inferring it from the description. Its options and counts follow Current / Archive / All; a selected country absent from that scope remains available with count 0. Company-option counts keep their unfiltered-list meaning.

**Include job descriptions** also searches the original description and complete, current translations (`searchIn=all` in the URL). Zero results offer an **Also search job descriptions** link; no extra full-text count runs before you choose it. Chinese queries show a language hint: there is no automatic query translation, so use the switch to find existing translations. The URL preserves the switch across reloads and sharing; clearing filters keeps it. A full-text timeout asks you to narrow the query.

A query defaults to **Relevance**, with title phrases and basic-information matches before description-only matches. Relevance has a fixed descending order; its direction button is hidden. Choose another sort explicitly, or use **Sort by rank value** next to the count. Without a query, the normal scope-dependent sort applies.

Country and search scope are **not saved in views**. The save dialog explains this; when they are the only conditions, Save view is disabled with the same explanation. Saved queries use the default basic-information search.

### Multi-select filters

On `/jobs`, source, city, country, company, workplace, contract and job status each accept several values (application status was already multi-select):

- Open a filter and tick the items you want; city and source have a search box (typing `munc` finds München); the bottom shows "N selected · Clear · Done". Keyboard: Tab to the button, Enter / ↓ to open, ↑ ↓ to move, Enter to tick, Esc to close.
- Rule: **within one filter any match is enough; across different filters all must match**. For example "city Berlin + München, workplace remote" = remote jobs in Berlin or in München. Choosing München also brings in its metro-area spellings (Garching etc.).
- A row of tags below the search box lists every selected value, and clicking × removes just that value; on phones you can see and remove them without opening the filter panel. A multi-select filter counts as 1 in "Filters (n)".
- The URL uses repeated parameters: `/jobs?city=Berlin&city=M%C3%BCnchen&workplace=remote`. Old single-value links (`?city=Berlin`) still work and read as "just one selected". Empty, unknown and duplicate values are ignored.
- When saved as a view, one value is written as a single value (`city: München`, like earlier files) and several as a list (`city: [Berlin, München]`); when hand-editing `interests.yaml` both forms work. The view card on `/interests` shows "City: Berlin or München"; on the Today page, switching to this view filters by the several values, and the number on the tab matches. The view tabs on the Today page remain single-select (views are mutually exclusive presets).
- Rollback warning: if you roll back to a version from before multi-select filters, the old code does not understand the list form; before rolling back, change multi-value views to a single value or delete them, then run `pnpm config:check`.

### Filtering by company

The "Company" filter on `/jobs` is a multi-select like city (several companies = any of them; with other filters all must match). The URL is `/jobs?company=SAP%20SE&company=Zalando%20SE`, and a saved view stores `company: [SAP SE]` (always a list).

- The drop-down lists the companies that have jobs in the list as `/jobs` opens (hard-filtered and closed jobs not counted), most jobs first, with the number next to each name. It loads at most `ui.yaml: filters.company_options_max` companies (500) and shows the first `filters.company_options_visible` (50) until you type in its search box; a note under the list says so. A company outside the loaded set is still one click away: click its name.
- Click a company name in a job row or on a job's detail page to list that company's jobs (`/jobs?company=…`). The click does not open the job.
- The company link opens the default list, without "show filtered" or a job-status filter. A hard-filtered or closed job of that company is absent; add those filters to see it.
- A name matches a company the way the hard filter's company exclusions do: case, accents and legal forms (GmbH, SE …) are ignored, and the aliases of `pipeline.yaml` count. It is never a part of a name: "SAP" does not bring in "SAP Fioneer". A name typed in a link (`?company=sap`) is rewritten to the company's display name when it picks exactly one company.
- A company that was renamed or merged since a view was saved can show as selected with no jobs; pick it again in the drop-down.
- When one company is stored twice (an alias added later: the old row and the new row both exist), its name picks both rows, so the list after the click can hold more jobs than the number shown next to that row in the drop-down.

Command-palette job search (⌘K / Ctrl K) also leaves out dormant jobs.

### Companies overview

Open **Companies** (`/companies`) from the sidebar, phone menu or command palette. It lists companies with jobs visible
in the default `/jobs` list: hard-filtered, closed and dormant jobs do not count; unscored, possibly closed and manually reopened
jobs follow the same rules as `/jobs`. Each row shows the open-job count, highest current rank value and most recent
first-seen time (in the configured timezone). Search by company name; click a sortable column again to reverse its
direction. On phones, use the sort selector and arrow button above the cards. Missing scores stay last in either
direction. Pagination uses `ui.yaml: companies.page_size` (50 by default).

- Click a company name to open `/jobs?company=…`. Each overview row counts one stored company record; when several
  records match the same name or alias, the link opens their combined jobs, so the result can exceed that row's count.
- **Watch** and **Unwatch** update the watch list immediately, also shown on `/interests`. Unwatch removes every matching
  saved spelling, even when the row uses a shorter name. If the database also marks the company as watched, the success
  message explains that it remains watched. **Watched (database flag)** means there is no matching watch-list entry;
  there is no Unwatch button for that flag here.
- If an alias change leaves a row with an old company key, or its name exceeds the watch list's 120-character limit,
  the row links to `/interests` instead of offering Watch. Add the current company name or a shorter alias there.
- **Exclude…** opens the **Excluded companies** field at `/me#exclude-companies`. Add the company there and save your
  preferences. Saving alone does not re-run filtering: the next processing cycle applies the new preferences, or run
  `pnpm refilter` to update existing jobs sooner. Fully filtered companies then leave this overview. The note above the
  list counts entries in your profile's exclusion list, including companies with no visible jobs; database-only flags
  are not part of that count.

### Remote jobs and watched companies

Two rules decide where a job may be, besides your cities (`/me` → What I want).

**Remote scope** (the select on `/me`, `/settings` and in the setup wizard; a hint under it explains the chosen kind). For the Germany pack, `home_country` reads "Remote from Germany (incl. EU / Europe / EMEA / worldwide remote)":

| Remote job | Result |
|---|---|
| "Remote - Berlin", "Munich (Remote)" (a city of yours) | kept: your cities come first |
| "Germany (Remote)" | kept, noted as a country-level place |
| "Remote - EU", "Europe", "EMEA", "EEA", "Europa" | kept: the home region |
| "Remote - Worldwide", "Anywhere", "Global", "weltweit" | kept |
| "Remote - Spain", "Remote, UK", "Austria" | excluded: another country |
| the same, but the description says it hires from anywhere in Europe or from Germany | kept, noted |
| "Remote - USA", "Americas", "APAC", "Austin, TX" | excluded (the description can rescue it) |
| a title such as "AI Engineer - US" or "(Americas)" | excluded; the description cannot rescue it. A title that also names EMEA or Europe is not excluded |
| "Remote" without a place, or no location | kept, noted that it does not say where it hires |

`none` drops remote jobs unless the posting names one of your cities, `worldwide` keeps all of them, and `region` keeps the places of the regions and countries you pick (plus worldwide). The scope in `/settings` decides where the remote searches look; the filter uses the one in My profile.

**Watched companies keep their on-site and hybrid jobs in any city of your country.** For a company on the watch list (`/interests`, **Watch** on `/companies`, or the database flag), a job that is not remote passes the location check when at least one of its places is in your home country, whatever the city; the job is noted "Watched company: Hamburg is not one of your cities but is in your home country, so the job is kept". Only the location check is relaxed:

- A place the source does not tie to your country does not count: "San Francisco", "Bengaluru" or a small town the city table does not know, with no country given by the source. Such a job is still excluded as "Location not on your list". Most sources give the country (Arbeitsagentur always, LinkedIn writes "…, Germany").
- Remote jobs follow the remote scope above. Work mode, contract, student roles, salary floor, seniority, excluded keywords and companies, deal-breakers and your own keep / exclude decisions are unchanged, and so are scoring and the push rules.
- The list is read on every filter run, so adding or removing a company changes its jobs on the next cycle. If `interests.yaml` cannot be read, the list counts as empty (a warning is logged) and only the database flag applies.
- A company is only collected in every city when it has an ATS board (below) or a source returns its jobs: otherwise only the searches for your cities find them. `/interests` marks watched companies without a board.

### Sorting the list

On `/jobs` the column heads **Rank value**, **Salary / yr** and **Freshness** sort the list (on a wide screen; the other columns do not sort):

- Click a head to sort by it, highest / newest first; click the same head again to flip the direction. The arrow next to the head shows the current column and direction; the other sortable heads show a faint double arrow. Keyboard: Tab to the head, Enter.
- **Salary / yr** sorts by the comparable annual figure in the market's base currency (the middle of a stated range, else the one stated bound; the same figure as the median on the detail page). A salary marked "possibly another region's pay" comes after all comparable ones; jobs without a usable salary (not stated, under review, or not yet worked out in the current base currency) are always last, in both directions. Unscored and hard-filtered jobs are always last when sorting by rank value.
- On a phone (and in a narrow window) there are no column heads: use **Sort by** in the filters (it also has "Annual salary", "Posted" and "Last listed") and the arrow button next to it, which flips the direction. Heads, drop-down and button change the same setting, so the order is the same at every width.
- The URL keeps the order: `/jobs?sort=salary&dir=asc` (`dir` is left out for the default, descending). Old links such as `?sort=rank` keep working. Saved views do not store the order. Today and Favorites keep their own fixed order.

### Seen and unseen jobs

Every job remembers whether you have looked at it, so after opening a few and going back you can tell them apart:

- **Unseen** rows have a bold title with a small dot in front of it; seen rows have a normal-weight title. Today, `/jobs` and Favorites show it the same way (screen readers hear "Unseen: …").
- A job becomes **seen** when its detail page is actually shown in the browser (only hovering a link or prefetching the page does not count), when you click "View original posting" (also the button in the phone's bottom bar, and the links in the Sources panel), or when you act on its row (★, 👍, ✕, or marking it closed). The first time is kept.
- **Unseen only** (next to "Favorites only" on `/jobs`) lists just the unseen jobs; it combines with every other filter and lives in the URL (`unseen=true`), not in saved views.
- **N unseen · Mark all as seen** next to the result count: on `/jobs` it covers every page of the current filtered list, on Today the jobs of the current view. The toast has "Undo", which takes back exactly that batch (jobs you had seen before stay seen).
- To make a job unseen again: "Mark as unseen" in the "⋯" menu of the detail page, or `u` on a list row (press it again to mark it seen).
- **New since your last visit**: the app still remembers when you last opened Today or `/jobs` (a visit is a session: opens less than 30 minutes apart count as one). When `/jobs` is sorted by freshness, newest first, a divider under the last new job says "Above: N new since your last visit" (it is on the page where the boundary falls). In any other order the line "N new since your last visit · newest first" next to the count links to that order; Today shows the sentence only.
- After the upgrade, jobs first found before your last visit, and every job you applied to or starred, start as seen; newer ones start unseen. Without any recorded visit everything starts as seen.

### Closed jobs and the archive

Job Radar never deletes jobs, postings, scores, translations or analyses automatically. They remain on this machine.

Use **Current / Archive (N) / All** under the `/jobs` title. Current is the usual list; Archive contains effectively closed
jobs (your judgement takes precedence) and dormant jobs. Undormant possibly-closed jobs, including those marked by a
closing phrase, stay in Current. The two scopes do not overlap; All combines them under the same filters. The archive
count follows your search and other filters, and **Mark all as seen** covers every page of the selected scope.

The scope options are links grouped as an in-page view filter: use Tab or Shift+Tab to focus each option and Enter to
open it. The active scope is marked as the current option.

Choosing a scope writes `scope=current`, `scope=archive` or `scope=all`. Status filters then intersect that scope:
Current + Closed is empty, and removing the status chip returns to Current. **Clear filters** keeps the scope. Old links
without `scope`, including `?status=closed&status=possibly_closed`, and saved views keep their previous results: selecting
a status uses All; without a status they use Current. There is no redirect.

Outside Current, **Reason** offers **Closed by you**, **Taken down at the source** and **Not listed for weeks**
(`reason=manual`, `reason=gone`, `reason=dormant`; multiple values match any). Reasons are cleared when leaving Archive.
A reason already in a Current URL still applies and has a removable chip, although its selector is hidden. Scope and
reasons are not saved in views; saving from Archive or All explains this in the dialog.

Archive defaults to **Last listed**, newest first (ties use the job id); an explicit sort still wins. Returning to Current
clears an explicit last-listed sort and its direction. Last listed is the newest fetch of any source posting, not a link
check. Archived rows in any scope show it as a relative time, with the first-seen date on hover; their detail pages also
show the source date. Without a source date they say **Last listed: not recorded**. Freshness and the date filters still
use first seen.

**Seen again · {relative time}** marks a job collected again within `job-archive.yaml: relist.badge_days`
(14 days by default), regardless of its current status. Hover for its first-seen date, the seen-again count and the
meaning: **Collected again by this tool, not necessarily re-posted by the employer**. A manually closed job stays
closed; a closing-phrase mark also stays. The detail page keeps the seen-again date after the badge expires.

The **Seen again** quick filter (`relisted=true`) selects that same badge window within the chosen scope; its count
matches the list, reload keeps it, and **Clear filters** removes it. Like scope and reasons, it is not saved in views.
Today shows a **N jobs seen again** link when there are active, non-ignored relists in today's or the latest cycle's
window, intersected with the badge window. The link opens Current with the Seen again filter and carries Today's
Include filtered, Hide language-required and High-value switches. Its list can contain more jobs than the note.
Relists do not refresh first seen or posted dates, freshness, Today's new-job list or KPIs, new-since-visit counts,
navigation badges or Insights; they add no AI work or Telegram push.

**Not listed for weeks** is a yellow hint for dormant jobs, still `possibly_closed`. After 30 days possibly closed
(`pipeline.yaml: lifecycle.dormant_after_days`), they leave the default jobs list, company overview, command-palette
search and automatic processing. With the normal 7-day unseen grace period this is about 37 days since a source last
listed them; a source held back by incomplete collection gets the full 30 days after it first qualifies as possibly closed.
Find them in **Archive (N)** or with the legacy **Possibly closed** status filter; the detail shows the last listing date, **Still open**
and **Confirm closed**. A source listing them again, or choosing **Still open**, wakes them. Dormant jobs no longer receive
ordinary link checks. Bookmarks, any user open/closed judgement and applications in `new` through `offer` protect jobs
from dormancy; rejected, withdrawn and ignored applications and hard-filter overrides do not. Nothing is deleted.
Any stored closing-phrase quote stays in the detail page's evidence row, including after the job becomes dormant.
Stored scores and other results remain visible in explicit status views; after waking, the next filter and signal steps
catch up to the current preferences. The jobs badge excludes dormant and effectively closed jobs; today's badge also
excludes jobs closed today, so the list, company and badge numbers can become smaller after upgrading.

A job can close in two ways: the app finds out, or you tell it.

- **You mark it**: "Mark as closed" on the detail page (with an optional note of up to 200 characters, shown on the page afterwards), the fourth button on a list row (⊘), or `c` on a row. The toast has "Undo", which puts back exactly what was there before. Marking a job closed also marks it seen. "Reopen" (the same button / key) brings it back; your judgement holds until you change it, even when a source lists the job again (the detail page then says "A source still listed this job on …", so you can reopen it).
- **The app finds out**: a job no source has returned for `possibly_closed_after_days` days (7), while each of its channels has had a successful run since then, is **possibly closed** (yellow tag). This is a time-based hint, not proof: searches only return postings inside their time window, so not showing up in one query means little. The link check decides: a live link reopens the job (except one the page itself marked as no longer accepting applications), it is closed only when every link checked returns 404 / 410, and a job seen again by any source becomes active again (unless the page says it no longer accepts applications, or you closed it yourself) (see [Sources](sources.md#how-jobs-get-marked-possibly-closed)). Active jobs no source has returned for `unseen_link_check_after_days` days (14) also get a direct link check, regardless of channel runs, at least `unseen_link_check_interval_days` days (7) apart; they get no yellow tag, and an unanswered check leaves them active. This fallback is the plain link check (HEAD, then GET when needed, with its own User-Agent); it does not read robots.txt and also reaches watched jobs whose recheck got no answer, including when robots.txt forbade the page. Jobs you **starred** or **follow** (application status interested, preparing, applied, interviewing or offer) also get their posting page rechecked every 72 hours (at most 10 per cycle): 404 / 410 → **taken down at the source**; a sentence such as "no longer accepting applications" / "Stelle ist bereits besetzt" in the visible text of the page → **source says no longer accepting**, which only marks the job possibly closed, with the sentence and a short quote kept as evidence (hover the tag, or read it under the detail page's header, with a link to the checked page). Confirm it with "Confirm closed", or answer "Still open" (that sticks: later checks no longer hide it).
- **Where closed jobs go**: `/jobs` keeps them in Archive, together with dormant jobs. Undormant possibly-closed jobs remain in Current. Today keeps its existing scope, and Favorites keep listing every job with its tag. Jobs you closed are not scored and not pushed to Telegram.
- **How the recheck behaves**: it reads one page per job like a careful reader: its own User-Agent (`JobRadar/2 …`), robots.txt obeyed (a page robots.txt forbids is not fetched and stays "not checked"), one request per site every 3 seconds, at most 1 MiB read, only the visible text is searched (scripts, hidden elements, navigation, sidebars such as "other jobs" and footers are ignored; at most the first 200,000 characters). Only public web addresses are requested: a link or a redirect to this machine, the Docker network or the local network is not followed, a redirect chain ends after 5 hops, and a redirect to another site is followed only when that site's robots.txt allows it. A page that answers normally opens a possibly closed job again. If neither the recheck nor the fallback gets an answer, for example because a page requires a login or refuses bots, mark the job closed yourself when needed. The phrases come from the market packs (`closed_posting.phrases` in `rules.yaml`, see `market-packs.md`); add your own in `ui.yaml` (`job_checks.closed_recheck.extra_phrases`), or switch the recheck off there (`enabled: false`). Rates and sizes are in `pipeline.yaml` (`lifecycle.watch_recheck`, see `configuration.md`).
- Rollback: an older version ignores your closed / open judgements and the stored evidence, but rejects the `job_checks` block in `ui.yaml`: remove it before rolling back.

### Why is the score empty

The rank value comes from AI scoring. A just-fetched job has no score yet and sorts after the others by posting time. Scoring is done by ai-worker after each cycle. If it never gets a score:

- Run `pnpm run doctor` and look at "profile sufficient for AI scoring" and "no AI backlog";
- `/me` needs at least a summary or skills, otherwise scoring pauses (a banner appears at the top of the Today page);
- On the detail page you can click "Score now" to score a single job.

### On your phone: Telegram

After each cycle, qualified new jobs (rank value >= 70, or >= 60 with a high-value signal (by default a stated amount above your salary floor, or equity); watched companies ignore the threshold) are pushed to Telegram one by one. Each message has three buttons, 👍 Interested / 🚫 Ignore / 📄 Tailor résumé (a tap writes straight into the application record; the résumé button appears only when resume-kit is configured), and a ⭐ Save button (it only adds the star, does not change the application status, the button stays, and tapping again removes it). At most 10 are pushed per cycle, the rest are in the web app. Quiet hours are 22:00-07:00. The rules are in `telegram.md`.

## 4. Command line

### Run a cycle right now (without waiting for the schedule)

```bash
pnpm cycle:run                                  # run one full cycle: collect -> process -> AI -> push
pnpm cycle:run --channel arbeitsagentur         # run just one channel
pnpm cycle:run --channel <id> --dry-run         # collect and parse in memory, write nothing
pnpm cycle:run --backfill 2d --channel linkedin-guest  # queue a manual backfill for the runner
```

`--backfill <N>h|<N>d` accepts integer hours or days (1–720 hours, also limited by
`collect.max_backfill_hours`). It only queues a request, requires `--kind manual` (the default), and cannot be combined
with `--dry-run`. Follow it on `/sources` or the `/settings` request queue; see [Manual backfill](sources.md#manual-backfill).

For a full cycle, you can also click "Run a cycle now" on the "Manual actions" tab of `/settings`.

A dry run sends real requests, so paid channels still bill them, but writes nothing to the database. When the database
is reachable, migrated and readable, it reads the persisted monthly usage, circuit state and stored postings through a
read-only connection. Requests follow the same budget checks as a real run: exhausted quotas stop requests unless an
overage price is configured and the dollar budget still allows them; circuits still cooling down also skip requests.
The log `cascade has no available channel` gives the reasons when no channel can run. This is not a hard billing cap.

Stored postings are reused by each channel's rules: Arbeitsagentur, StepStone and XING use `reuse_known_details`;
JSearch only falls back to stored descriptions and makes the same number of detail requests; LinkedIn session skips
opening stored jobs from its own channel id. Dry-run usage is not added to the month's total, so repeated dry runs can
each use the same remaining allowance. Brave has no monthly budget check. If the database is unreachable, unmigrated or
unreadable, the CLI warns and starts from empty state; paid channels then have no protection from persisted monthly
usage limits. See the [LinkedIn session guide](linkedin-session.md#live-smoke-test) for its daily page cap and login-state limits.

### Reading jobs and JDs in the terminal

The web app is the most convenient day to day; to look quickly in the terminal you can query the database directly (read-only). The commands below use the database account inside the container, so you do not type a password.

The 20 top-ranked jobs today (those that passed the hard filter):

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select j.id, s.rank_value::int as rank, left(j.title, 50) as title, left(c.name, 24) as company,
       j.workplace, to_char(j.first_seen_at at time zone 'UTC', 'MM-DD HH24:MI') as seen
from jobs j
join companies c on c.id = j.company_id
left join lateral (select * from scores where job_id = j.id order by created_at desc, id desc limit 1) s on true
where j.status = 'active' and s.filter_result = 'passed'
order by s.rank_value desc nulls last, j.first_seen_at desc
limit 20;
SQL
```

The full JD of one job (replace `123` with an id from above, or the number in the detail page address `/jobs/123`):

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -x -v id=123' <<'SQL'
select j.id, j.title, c.name as company, j.locations_json, j.workplace, j.contract,
       j.german_level_required, j.salary_json, j.description
from jobs j join companies c on c.id = j.company_id
where j.id = :id;
SQL
```

Search titles and descriptions by keyword (replace `kubernetes` with your word):

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v q=kubernetes' <<'SQL'
select j.id, left(j.title, 60) as title, left(c.name, 24) as company
from jobs j join companies c on c.id = j.company_id
where j.search_tsv @@ plainto_tsquery('simple', :'q')
order by j.first_seen_at desc limit 20;
SQL
```

To save a JD as a file: "Tailor resume" on the detail page exports it to `data/exports/jd/<company>-<title>-<date>.md` (with front matter); you can also tap 📄 in Telegram.

### Other common commands

| Command | Purpose |
|---|---|
| `pnpm run doctor` | Full check-up |
| `pnpm config:check` | Check the format after editing `data/config/*.yaml` or the profile (including the cross-file check `ai.yaml` <-> `models.yaml`) |
| `pnpm ai:probe --provider <provider> --model <model id>` | After adding a new model to `data/config/models.yaml`, send one tiny request with it before choosing it on the settings page (`--model` requires exactly one `--provider`; without `--model` it shows whether each provider is available right now) |
| `pnpm sources:list` | List all collection sources and their health (`--status failing`, `--json`, `--strict`), see `sources.md` |
| `pnpm deliveries:show --run <id>` | Inspect a paid run’s delivery ledger and usage; see [sources](sources.md#paid-delivery-ledger) |
| `pnpm telegram:test` | Send a test message to confirm Telegram works |
| `pnpm reprocess` | After rules change, re-parse already stored jobs with the new rules (`--split-merged`: separate jobs that older versions merged because of names in a non-Latin script, see [extraction.md](extraction.md#company-and-title-keys)) |
| `pnpm db:studio` | Open Drizzle Studio to browse database tables in the browser |
| `scripts/ops/backup.sh` / `scripts/ops/restore.sh` | Manual backup and restore (see `backup-restore.md`) |

## 5. Suggested daily routine

1. After 07:00, read the Telegram summary and pushes; tap 👍 on those to follow up, and ⭐ on those you want to keep for later (see them in `/favorites`).
2. When you have time, open `/` and go through today's new jobs; for those worth applying to, open the detail page to read the JD and the match reasons.
3. After applying, change the status on the detail page or in `/pipeline`; the system reminds you to follow up based on days elapsed.
4. Run `pnpm run doctor` once a week, or whenever an alert arrives.
