# Tavily search (ATS board discovery)

The `tavily` channel uses the Tavily Search API to find "company careers pages that are not yet in `ats_boards` of `sources.yaml`" (Greenhouse / Lever / Ashby / Personio / SmartRecruiters). It does not collect jobs; it only writes newly found boards into the candidate table, and under "Discovered boards" on `/sources` you add or ignore them with one click. It replaces Brave Search with exactly the same role; the `brave` channel is still there, off by default.

## Account and key
1. Sign up at <https://app.tavily.com> (no card needed). The free tier gives 1000 credits per month; after that you can switch to pay-as-you-go (about $0.008 / credit at the time of writing; check the website).
2. Copy the API key from the console (starts with `tvly-`).
3. Put it in `.env`: `TAVILY_API_KEY=tvly-...` (`.env` is gitignored; do not commit it or paste it into chat or logs). `.env.example` has only an empty placeholder.
4. Restart the runner (`scripts/ops/deploy.sh`, or let the container re-read `.env`). `sources.tavily.enabled` is already `true` by default; no config change needed.
5. Without a key the channel shows "Not configured" on `/sources`, the doctor "channel tavily" check is a warning naming `TAVILY_API_KEY`; no request is sent and it does not count as a failure.

## Credits
- One search costs 1 credit (`search_depth: basic`, also `fast` and `ultra-fast`); `advanced` costs 2.
- By default at most one search run per day (`interval_hours: 24`) and at most 30 searches per run (`max_queries_per_run`): about 900 credits a month, within the free 1000.
- Usage is recorded per calendar month (time zone of `schedule.yaml`) in the channel's monthly usage (the progress bar on `/sources`); after `monthly_credit_limit` is used up the channel stops searching, which is not a failure and does not open the breaker, and resumes automatically next month. To go beyond the free quota: set `credit_cost_usd` to the unit price (about 0.008) and give `monthly_budget_usd` a ceiling; only the part beyond the quota is then counted against the budget in dollars.
- When Tavily returns `432` (plan credits used up) or `433` (pay-as-you-go limit), this cycle stops immediately and the breaker opens; after you raise the limit in the console, it probes automatically once the breaker cooldown has passed.

## Configuration (`data/config/sources.yaml` -> `sources.tavily`)
| Key | Meaning |
|---|---|
| `enabled` | Switch (on by default). Do not turn it on together with `sources.brave.enabled`, it would search twice |
| `api_base_url` | `https://api.tavily.com`; request `POST /search`, `Authorization: Bearer` |
| `search_depth` | `basic` (default) / `fast` / `ultra-fast`: 1 credit; `advanced`: 2 credits, more relevant results |
| `keywords_per_query` | How many leading words of each `search.yaml` keyword group to take, joined with OR into one query (default 2) |
| `interval_hours` | Do not search again if the last discovery was less than this many hours ago (default 24) |
| `max_queries_per_run` | Maximum searches per run (ATS x keyword group x city). Default 30 |
| `max_results` | How many results to take per search (Tavily's maximum is 20) |
| `monthly_credit_limit` | Credits included in the plan per month (free tier 1000); also the denominator of the monthly usage progress bar |
| `credit_cost_usd` | Price per credit beyond the limit; 0 = never search beyond it |
| `monthly_budget_usd` | Counts only spend beyond `monthly_credit_limit` (cannot exceed `paid_total_monthly_budget_usd`) |
| `throttle` | Interval between two searches |

## How it works
- Each query = one ATS x one keyword group of `search.yaml` x one city. For example `KI Engineer OR KI-Entwickler jobs München`, with `include_domains` set to that ATS's hosts (`jobs.lever.co`, `jobs.eu.lever.co`; for Personio `jobs.personio.de`). Tavily has no `site:` operator, so the host restriction relies on `include_domains`.
- Every URL in the results must pass `boardFromUrl` (which only accepts the official hosts and paths of the five ATS), and any other URL is dropped; boards already in `ats_boards` of `sources.yaml` are not suggested again.
- The channel never modifies `ats_boards` of `sources.yaml`; a candidate is written there only when you click "Add" on `/sources`.

## Switching back to Brave
`sources.tavily.enabled: false`, `sources.brave.enabled: true`, and set `BRAVE_SEARCH_API_KEY` in `.env` (<https://brave.com/search/api/>, free tier 2000 requests per month).

## Live smoke test
```bash
pnpm cycle:run --channel tavily --dry-run   # up to 30 searches = up to 30 credits; only prints candidates, writes no database, updates no run marker
```
Tavily deducts credits. Things to confirm: whether `include_domains` matches Personio subdomains, and that the candidates really contain new boards.
