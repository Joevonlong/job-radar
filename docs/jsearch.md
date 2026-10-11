# JSearch (Google for Jobs, RapidAPI)

The `jsearch` channel uses the JSearch API to fetch jobs aggregated by Google for Jobs, complementing LinkedIn and ATS, especially for jobs posted only on a company's own site. It is an aggregator source (family `google`, original-post link priority 4): if the same job has a higher-priority link from another channel, that one wins; but the job's own original-post link (the link "View original posting" opens) is first picked as the best among the several links JSearch returns (see below).

## Account and key
1. Subscribe to JSearch on RapidAPI (<https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch>, vendor OpenWeb Ninja). The free tier is 200 requests per month (hard limit, no card); paid tiers are on the plan page (Pro 10000 requests/month, $0.003 per request over that, prices at the time of writing).
2. Put the RapidAPI key in `.env`: `JSEARCH_API_KEY=...` (gitignored; never commit it or paste it into chat or logs).
3. In `data/config/sources.yaml` set `sources.jsearch.enabled` to `true` (or switch it on in the "Channels" tab of the settings page).
4. Without a key the channel shows "Not configured" on `/sources`, sends no request, and does not count as a failure.

## Configuration (`data/config/sources.yaml` -> `sources.jsearch`)
| Key | Meaning |
|---|---|
| `enabled` | Switch (off by default) |
| `api_base_url` | `https://jsearch.p.rapidapi.com`; its host is also used as `X-RapidAPI-Host` |
| `country` / `language` | `country=de`; leave `language` empty = the country's main language |
| `pages_per_query` | `num_pages`: how many pages to read per query (10 results per page, **each page counts as one request**) |
| `keywords_per_query` | How many leading words of each keyword group are queried, one query each (Google for Jobs has no reliable OR). Default 1 |
| `monthly_request_limit` | Requests included in the plan per month (free tier 200); usage is recorded as a request count in the channel's monthly usage (the progress bar on `/sources`); once used up the channel sends no more requests |
| `overage_cost_per_request_usd` | Price per request beyond `monthly_request_limit`; 0 = never send beyond it. If greater than 0, it is counted against `monthly_budget_usd` at this price, and it stops when the budget runs out |
| `monthly_budget_usd` | Counts only spend beyond `monthly_request_limit` (cannot exceed `paid_total_monthly_budget_usd`) |
| `pace_requests` | Spread the monthly request count over the calendar (on day N of the month use at most `ceil(limit x N / days in month)`), so the first few cycles of the month do not use up the quota |
| `fetch_details` / `max_details_per_query` | Fetch `/job-details` only when the search result has no body text (at most 20 ids at a time, each id counts as one request). Off by default |
| `apply_publisher_preference` | When there is no direct company-site link, the original-post link (the link "View original posting" opens) is picked in this publisher order (case-insensitive, substring match); publishers not in the list rank last |
| `rate_limit_retries` | How many more attempts after a per-second / per-minute rate limit (429), waiting one `throttle` interval before each |
| `throttle`, `max_results` | Same as other channels |

## How it works
- Each query = one keyword group of `search.yaml` x one city (or remote). Request: `GET /search?query=<keywords> in <city>&page=1&num_pages=N&country=de&date_posted=today|3days|week|month`; remote queries carry no city and add `work_from_home=true`. `date_posted` takes the smallest tier that covers the lookback window (<=24h today, <=72h 3days, <=168h week, otherwise month).
- A default cycle = 3 keyword groups x (2 cities + remote) = 9 requests. The free tier is 200 per month, so by default only the first keyword of each group is queried, and spread evenly over the month; to query more, upgrade the plan and raise `keywords_per_query` and `monthly_request_limit`.
- The response handles two envelopes: RapidAPI `/search` with `data: [...]` and `/search-v2` in the OpenAPI file with `data: { jobs: [...] }`. Records without a `job_id` are dropped; records missing a title / company are stored as is and marked `parse_failed` by the pipeline.
- Original-post link (the link "View original posting" opens): direct links first, meaning the API marks it `is_direct`, the domain is the employer's own site (subdomains included), or it is an official ATS board URL (Greenhouse / Lever / Ashby / Personio / SmartRecruiters); the rest are ordered by `apply_publisher_preference`, then by API order. Tracking parameters such as `utm_*` and `gclid` are stripped from the link (the raw record is untouched). `sourceUrl` is the first publisher's job page (a 404 there means the job is gone), not Google's panel link. For JSearch sources, "View original posting" on the detail page prefers the link picked above (`apply_url`) rather than the first publisher's job page; this is the opposite of company ATS sources (which prefer the job page, to avoid opening an application form).
- Salary: `job_min_salary` / `job_max_salary` / `job_salary_period`; the API carries no currency, so it is recognised from €, £, $, CHF, EUR etc. in the salary text (`job_salary_currency` is also accepted); if it cannot be recognised only the text is kept, with no structured salary (nothing is guessed).
- Remote: `job_is_remote: true` -> `remote`; the AI-enhanced field `work_arrangement`, when present, takes precedence; `false` only says "not fully remote" and is recorded as `unknown`.
- `isAgency` is not filled (JSearch does not say); agency detection is done by the pipeline's `agency_names` rule.

## Usage and circuit breaker
- One request (one page) = 1 usage unit; failed requests are not counted. Usage is recorded only after success, so a 5xx retry does not double count.
- `429`: if the response body (or `x-ratelimit-requests-remaining: 0`) says the monthly quota is used up -> no retry, **open the circuit breaker immediately** (probe once after `circuit_breaker.cooldown_hours`) and send the existing "channel circuit open" Telegram alert; if it says an hourly / daily limit -> no retry, stop trying this cycle, count one failure; otherwise (per-second rate limit) -> wait one throttle interval and retry `rate_limit_retries` times, and if it still fails count one retryable failure.
- `401` / `403` (invalid key or not subscribed to JSearch) -> `auth_expired`, triggers the "credentials invalid" alert.
- Monthly usage used up / this period's even-spread share used up -> `budget_exceeded`, the remaining queries of this cycle are skipped; not a failure, no circuit breaker.
- Monthly usage is counted per calendar month (time zone of `schedule.yaml`); RapidAPI's billing month starts on your subscription day and may differ: trust the RapidAPI dashboard and adjust `monthly_request_limit` if needed.

## Live smoke test
```bash
pnpm smoke:jsearch                 # reads .env; one query = 1 request
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-jsearch.ts --remote
```
Writes nothing to the database; usage is shown only in the output and does not count toward the month. You can also use `pnpm cycle:run --channel jsearch --dry-run` (9 requests for one cycle).

## Notes
- The vendor's new documentation (<https://www.openwebninja.com/api/jsearch>) lists `/search-v2` (cursor pagination, `x-api-key` header, host `api.openwebninja.com`) as the current search endpoint; this channel goes through RapidAPI's `/search`. Field names are the same in both. Switching to the direct API would require changing the auth header and pagination, and is a separate change.
