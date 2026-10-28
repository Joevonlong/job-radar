# Apify (second-priority LinkedIn channel)

The `linkedin-apify` channel takes over the main LinkedIn search after the Bright Data free quota is used up (or it fails), fetching jobs through an actor on Apify.

## Account and token
1. Sign up for an Apify account (the Free plan includes monthly credit), and copy the Personal API token from Console -> Settings -> API & Integrations.
2. Put it in `.env`: `APIFY_TOKEN=...` (`.env` is gitignored; do not commit it or paste it into chat or logs).
3. Without a token (or with an empty `actor_id`) the channel shows "Not configured"; the cascade simply skips it, produces no failure record, and does not affect the circuit breaker.
4. On the channels page of `/settings`, confirm `linkedin-apify` is enabled (enabled by default); the monthly budget `monthly_budget_usd` (default 10 USD) is bounded by the global `paid_total_monthly_budget_usd`.

## Configuration (`data/config/sources.yaml` -> `linkedin.apify`)
| Key | Meaning |
|---|---|
| `enabled` / `monthly_budget_usd` / `throttle` / `max_results` | Same as other channels; `max_results` is the maximum results taken per query |
| `actor_id` | (protected: edit the file by hand) The actor, `username/actor-name` or a 17-character ID; default `valig/linkedin-jobs-scraper`; empty = not configured |
| `api_base_url` | Apify API address |
| `price_per_1k_usd` / `run_start_usd` | For accounting: price per 1000 results, and the start fee charged once per run. Use the price for your plan under Pricing on the actor page |
| `memory_mb` / `timeout_secs` | Memory and timeout of one run; the synchronous endpoint caps at 300 seconds, and a timeout is recorded as a retryable failure |
| `country_name` | Location of city queries = `<city>, <country name>` |
| `remote_locations` | The location used by remote queries per `search.yaml: remote_scope` |
| `date_posted` | How the actor's "date posted" filter is written: window <=24 hours / <=7 days / <=30 days / longer (empty = omit this key) |
| `input_template` | The actor input template; strings may use `{keywords}` `{location}` `{date_posted}` `{limit}` (when the whole string is `"{limit}"` it becomes a number); keys with empty values are omitted |
| `remote_input` | Keys layered onto the template by remote queries (default `urlParam: f_WT=2`) |

`input_template`, `remote_input` and `date_posted` are not shown on the settings page (they are actor-specific data); edit the YAML directly.

## How it works
- Each query = one synchronous run: `POST /v2/acts/<actor>/run-sync-get-dataset-items` (201 on success, 408 after 300 seconds, 402 when there is no credit). Keyword groups are merged as `"A" OR "B"` (over 200 characters it is split into several runs sharing the limit).
- Before triggering, the maximum number of results this run may request is computed from the remaining monthly budget (start fee deducted first), and sent to Apify as the hard caps `maxItems`/`maxTotalChargeUsd`; if the budget cannot cover one run plus one result it is `budget_exceeded` directly, and the same query goes to the next channel in the cascade.
- Accounting = start fee + results actually delivered x unit price; every result that was billed (duplicates and ones dropped by the local time window included) counts toward the channel's monthly usage and the global paid cap.
- A run is sent only once, with no retry (a retry would bill twice); three consecutive failures open the breaker, and it tries again after 24 hours.
- `external_id` is LinkedIn's numeric job id, the same as Bright Data, so the same job obtained through the two channels is merged into one.

## Posting dates and local time windows

When the requested window is narrower than the actor's day/week/month filter, the channel also filters locally.
For example, a 10-hour query uses a local 10-hour cutoff after the actor's day filter; a 24-hour query relies on the
actor's day filter without an additional local cutoff. The local comparison respects the precision of `postedDate`:

| Source time fields | Local comparison |
|---|---|
| Bare date (`YYYY-MM-DD`) | Day precision; exclude only when the whole supplied day is before the cutoff |
| ISO midnight with a consistent `postedTimeAgo` in seconds, minutes or hours | Exact timestamp |
| ISO midnight with missing, invalid, unsupported, conflicting or day/week-only relative text | Day precision |
| Non-midnight ISO timestamp with no recognizable conflict | Exact timestamp |
| Non-midnight ISO timestamp conflicting with a recognized relative label | Day precision, using the supplied date |
| Missing/invalid date or an unrecognized date format | Keep it; the time fields cannot establish that it is outside the window |

Relative labels are checked at collection time using their stated unit: “5 hours ago” means an age of at least
5 and less than 6 hours. They are never converted into a stored posting time. A placeholder such as
`2026-10-26T00:00:00.000Z` paired with “1 minute ago” therefore stays eligible when its day overlaps the window.
The raw payload and supplied date remain unchanged; bare dates still store as UTC midnight, and ISO timestamps
keep their supplied instant. The day-end allowance is only for filtering. This rule is specific to Apify.

## Live smoke test
```bash
pnpm smoke:apify              # reads .env; one query, at most 10 results, about $0.005
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-apify.ts --limit 5
```
It spends money on your Apify account; it writes nothing to the database, and usage is shown only in the output.
