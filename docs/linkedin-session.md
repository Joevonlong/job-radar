# LinkedIn session channel (Playwright)

The `linkedin-session` channel uses **your own LinkedIn login session** (a Playwright browser) to read LinkedIn's job search pages and job detail pages. It is position 4 of the LinkedIn cascade (Bright Data -> Apify -> Monid -> session -> guest). There is also a side channel, `linkedin-session:recommended`: it reads "Jobs recommended for you" once a day and does not take part in the cascade.

It is **read-only**: it opens pages and reads them; it does not like, apply, message, follow or fill in any form. On a login page or verification page (checkpoint / CAPTCHA / security verification) it stops immediately, opens the circuit breaker and sends a Telegram alert, and **never tries to get through automatically**: you complete the verification yourself in a normal browser.

> Status: code and tests are complete, but there has been no smoke test with a real logged-in session yet; you need to run `pnpm auth:linkedin` and log in once first (see "Live smoke test"). The page selectors were written from the public structure of LinkedIn's logged-in pages and tested with saved HTML fixtures; they have not yet been verified against a real logged-in session.

## Risk notice
- Reading LinkedIn automatically with a login session violates its user agreement; it may restrict or suspend your account. That is why it is off by default, the request volume is small (see below), it is read-only, and it stops immediately on verification. Whether to turn it on is your decision; the other channels in the cascade (Bright Data / Apify / Monid / guest) do not depend on it.
- The login file `.auth/linkedin.json` holds session cookies, equivalent to being logged in: do not commit it (gitignored), permissions 600, do not send it to anyone, do not put it in an image. If it leaks, sign out of all devices under LinkedIn "Settings -> Sign in & security -> Where you're signed in".

## First-time setup
1. On the **host** (not in a container), open a terminal in the project directory:
   ```bash
   pnpm exec playwright install chromium   # first time only
   pnpm auth:linkedin
   ```
2. A Chromium window with a UI opens at the LinkedIn login page. **You** enter your account and password and complete 2-step verification. When you see your own feed, **close the window**.
3. When you close the window the script saves the login state (cookies) to `.auth/linkedin.json` (directory 700, file 600). It **does not read, store or type passwords**; it cannot see anything you type in the window, and only saves the browser's cookies after a successful login.
4. If the database is reachable (`DATABASE_URL`), the script also marks the login state as "valid" and closes any circuit breaker that opened because of an expired login / verification, so you do not have to wait for the cooldown.
5. Try one cycle first, then turn the channel on:
   ```bash
   # first set linkedin.session.enabled to true in data/config/sources.yaml, then:
   pnpm cycle:run --channel linkedin-session --dry-run
   ```
   A dry run really opens LinkedIn pages (it makes requests) but writes nothing to the database and does not count toward the day's usage. With readable database state, stored jobs from the same channel id are no longer opened, as in a real run. Look at `fetched / parsed` in the output; if the channel is skipped, see [Live smoke test](#live-smoke-test).
6. If it is fine, leave `enabled: true`. When the runner is in Docker, `./.auth` is mounted into the container read-only (already set in `compose.yaml`); run `docker compose up -d --build` once so the image includes playwright-core.

`pnpm auth:linkedin --status` only shows the status without opening a browser: whether the file exists, the cookie expiry time, and the state the channel last knew.

## Configuration (`data/config/sources.yaml` -> `linkedin.session`)
| Key | Meaning |
|---|---|
| `enabled` | Switch (off by default). Without a login file the channel shows "Not logged in", the cascade skips it, and it does not count as a failure |
| `monthly_budget_usd` | Keep at 0 (there is no paid usage) |
| `throttle` | Wait a random 3-8 seconds between two page loads |
| `max_results` | Maximum results read per query (further limited by `search.yaml: max_per_group_per_location`) |
| `daily_request_limit` | Maximum LinkedIn pages loaded per calendar day (`schedule.yaml` time zone), search pages, detail pages and the recommended page combined, shared by both session channels. Default 200. When used up the channel is skipped and the cascade moves on, see [When the daily page limit is reached](#when-the-daily-page-limit-is-reached) |
| `max_pages` | How many pages of search results to turn per query (about 25 results per page) |
| `fetch_details` | Whether to open the detail page of every **new** job (JD, salary, work arrangement, applicant count). Jobs already in the database are not opened again: they are re-delivered as is (keeping the "last seen" time) and cause no request |
| `recommended_daily` / `recommended_max_results` | Whether to read "recommended for you", and at most how many results |
| `site.base_url` / `site.auth_file` / `site.country_name` / `site.remote_locations` | Site, login file path (relative to the project directory), country for city queries, locations for remote queries |
| `browser.*` | `headless`, page timeout, render wait, scroll count and pause (the list renders only visible cards), language, resource types not to load, User-Agent |

`linkedin_recommended` in `data/config/schedule.yaml` (`enabled`, `cron`, default every day 07:00) decides when "recommended for you" is read. It is not a separate scheduled job: in the processing cycle, the first cycle that finds "today's cron time has passed and it has not been read yet" reads it along the way; a manual run always reads it.

## How it works
- **Search**: each query = one keyword group of `search.yaml` x one city (or remote). URL: `/jobs/search/?keywords="A" OR "B"&location=<city, country>&f_TPR=r<lookback seconds>&sortBy=DD`, with `f_WT=2` added for remote. After opening, it scrolls the list so every card renders, reads each card's job id, title, company, location and posting time; then for jobs not in the database it opens `/jobs/view/<id>/` and reads the JSON-LD `JobPosting` plus the salary, work arrangement, employment type, applicant count and JD on the page.
- **Id and dedup**: the job id is LinkedIn's numeric id, the same as the Bright Data / Apify / Monid / guest channels, so the same job fetched through different channels is merged into one.
- **Raw data**: what is stored is the fields read from the page, and the JD is saved as HTML so a later `pnpm reprocess` can re-parse it. Cookies, request headers and whole-page HTML are not stored.
- **Login state** (`/sources`): **Not logged in** (no login file or no session cookie), **Valid**, **Expired** (the cookie expired, or the channel was taken to a login / verification page and you have not logged in again yet). It recovers automatically after you rerun `pnpm auth:linkedin`. The "last success" time is shown on the channel card.
- **Missing login file**: `isConfigured` is false, the cascade skips session and the next channel (guest) takes over; "recommended for you" does not run.
- **Only one browsing session**: the two session channels share one account and one counter, and only one browser is open at a time within the process.

## When a verification / login page appears
On the **first** such page the channel stops immediately (loads no more pages), then:
1. marks the login state "Expired" (`runtime_state`, visible on `/sources`),
2. throws a breaker-eligible error: login page / auth wall -> `auth_expired`; verification page / checkpoint / CAPTCHA / HTTP 999 / 403 -> `blocked`; one occurrence opens the breaker (`circuit_breaker.cooldown_hours`),
3. sends a Telegram alert: expired login -> "LinkedIn session expired, login required"; verification page -> "LinkedIn channel ... hit a verification page or was blocked" (telling you to complete verification in a normal browser). The same alert is sent only once per `alerts.dedupe_hours`,
4. hands this query and the rest of this cycle's queries to the next channel in the cascade (guest).

Recovery: log into LinkedIn yourself in a normal browser, complete the verification it asks for, then run `pnpm auth:linkedin`. HTTP 429 counts only as one retryable failure (no immediate breaker; consecutive failures open it). If the page structure changed (neither job cards nor a "no results" page) it reports a `parse` error and never quietly returns empty.

What was already read is kept. After the stop no more pages are loaded in that query; the postings already read, and those that need no page load (already stored, or list cards when `fetch_details` is off), are handed over. If at least one posting is handed over the run shows as interrupted on `/sources`, otherwise as an ordinary failure. The same applies to a network error or HTTP 429 part way through a query. Postings already stored are not read again next time, so they cost no pages; cards that still need their posting page are listed again by the next run. Reaching `daily_request_limit` part way is not a failure but a budget stop, see below.

## When the daily page limit is reached
The limit is checked before every page load. When it refuses a page part way through a query:
- **What is kept.** No more pages are loaded. The postings already read, and those that need no page load (already stored, or list cards when `fetch_details` is off), are still handed over and stored; cards that still need their posting page are left for the next run, which lists them again. When the limit hits on a result page, the result pages after it are not read.
- **How the run is recorded.** As **skipped** (`budget_exceeded`), like JSearch's budget stop: no failure is counted and the breaker is left alone, but it is no success either (the "last success" time does not move; a breaker probe that ends at the limit stays half-open). This skipped run is not used to mark jobs as possibly closed; another complete run of the same channel still counts (even an earlier query in the same cycle), because the mark is judged per channel and by time, not per query (see [Sources](sources.md#how-jobs-get-marked-possibly-closed)). With nothing to hand over it is a plain budget skip. Using up the limit exactly, with no further page tried, is a normal successful run; a query whose results fit on one page still tries the next result page, so a refusal there counts as stopped by the limit.
- **The cascade.** The same query goes to the next channel (guest, off by default), then the rest of the cycle's queries. That channel reads the whole query again, so the postings overlap (they are merged later in processing, not necessarily as raw postings). If you reordered the cascade so that a paid channel comes next, that is one more paid query per day, within that channel's budget.
- **The last query of a unit.** With no channel left (the default, guest off), the cascade records one more skipped row on the first registered channel of the order (Bright Data for the keyword searches) and skips the unit's remaining queries. When the limit hits on the unit's **last** query, a run that used to end normally now shows up: the collect step is `partial` if another attempt of the cycle succeeded, otherwise `failed` (even though postings were kept); the source is listed under failed sources in the Telegram summary; the per-source count at the top of Today shows it; and when no other source succeeded, the cycle can be recorded as failed with a "cycle did not finish" alert (the later steps still run).
- **"Recommended for you"** (`linkedin-session:recommended`) is a unit with a single query, so every stop by the limit is such a last query; both skipped rows are on `linkedin-session:recommended`. When the stop kept at least one posting the list counts as read for today and is not read again before the next slot; with none it stays due. A dry run never marks it as read.

## Containers and permissions
- In the runner container the Playwright base image ships the browser, and `playwright-core` is installed separately in the image (`build:runner` marks it external). `/dev/shm` is tiny, so `--disable-dev-shm-usage` is added.
- `.auth/` is mounted read-only into runner and web (web only uses it to decide "Not logged in / Valid", it does not browse). Permissions 700/600 work on macOS Docker Desktop; on a Linux host, if the container user cannot see a 600 file, change the owner of `.auth/` to the container user's uid rather than loosening the permissions.
- Running directly on the host also works: `pnpm cycle:run --channel linkedin-session`.

## Live smoke test
After you have run `pnpm auth:linkedin`:
1. `pnpm auth:linkedin --status` should show "Valid".
2. `pnpm cycle:run --channel linkedin-session --dry-run`: look at `fetched`, `parsed`, `parseFailed` and the sample titles; if the page selectors do not match, it shows up as a `parse` error or `cardOnly` (the detail page could not be read and only the list card was kept). With readable database state, an open circuit after repeated failures or a verification page skips the channel just as in a real run. To check selectors, run `pnpm auth:linkedin` first to reset the circuit, or wait for its cooldown to end.
3. `pnpm cycle:run --channel linkedin-session:recommended --dry-run`.
4. Check against the real pages: redact the page HTML and replace the fixtures in `tests/fixtures/linkedin-session/`, then run `pnpm test` to see whether the parser still passes.

Dry runs still do not read the persisted daily page count or login flag. Stored-job reuse only looks under the current channel id: `linkedin-session` and `linkedin-session:recommended` do not share stored postings during a dry run.
