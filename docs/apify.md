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
| `date_posted` | Value of `{date_posted}` for a template that uses the actor's coarse filter: window <=24 hours / <=7 days / <=30 days / longer (empty = omit this key). The default template does not use it |
| `input_template` | The actor input template; strings may use `{keywords}` `{location}` `{date_posted}` `{posted_within_seconds}` `{limit}` (when the whole string is `"{limit}"` it becomes a number); keys with empty values are omitted |
| `remote_input` | Keys layered onto the template by remote queries (default `urlParam: f_WT=2`); a key replaces the template's, except that two `{key, value}` lists merge by `key` with the remote entry winning, and an empty list changes nothing. A list of any other shape replaces the template's list, which drops its `f_TPR` |

`input_template`, `remote_input` and `date_posted` are not shown on the settings page (they are actor-specific data); edit the YAML directly.

## How it works

- **Exact window:** the default template sends LinkedIn's date filter with the query's own window, `urlParam: f_TPR=r<seconds>` (10 hours is `r36000`), so you no longer pay for records of the rest of the day. The actor's `datePosted` only offers day, week and month; when both are sent, `f_TPR` wins.
- **Order:** results are not newest first. The actor ignores `sortBy=DD` (measured), so it is not sent; when more jobs match than the limit, the ones returned are picked by relevance within the window.
- **Catch-up:** Apify always keeps the base window; automatic [catch-up](sources.md#catch-up-windows) is disabled
  because results are not newest first. It will be enabled only after newest-first results under the channel's
  active settings have been measured. A manual backfill can fetch more records per query and increase per-record charges.
- Each query = one synchronous run: `POST /v2/acts/<actor>/run-sync-get-dataset-items` (201 on success, 408 after 300 seconds, 402 when there is no credit). Keyword groups are merged as `"A" OR "B"` (over 200 characters it is split into several runs sharing the limit).
- Before triggering, the maximum number of results this run may request is computed from the remaining monthly budget (start fee deducted first), and sent to Apify as the hard caps `maxItems`/`maxTotalChargeUsd`; if the budget cannot cover one run plus one result it is `budget_exceeded` directly, and the same query goes to the next channel in the cascade.
- Accounting = start fee + results actually delivered x unit price; every result that was billed (duplicates and ones dropped by the local time window included) counts toward the channel's monthly usage and the global paid cap.
- A run is sent only once, with no retry (a retry would bill twice); three consecutive failures open the breaker, and it tries again after 24 hours.
- **Watched companies:** a [company query](sources.md#watched-company-queries) is one run with the company name as the keyword and your home country as the location, never the `remote_input` overrides. It is billed like any other run (start fee plus delivered results, at most `watched_company_queries.max_results`); results of other employers are billed but dropped. Switch it off with `company_queries: false` in this block. Company queries share this channel's `monthly_budget_usd` with keyword queries and can use it up first; see [shared budget](sources.md#watched-company-queries).
- `external_id` is LinkedIn's numeric job id, the same as Bright Data, so the same job obtained through the two channels is merged into one.

Records filtered out locally remain in the [delivery ledger](sources.md#paid-delivery-ledger).

## Posting dates and local time windows

When the requested window is narrower than the actor's day/week/month ranges, the channel also filters locally, as a
second check on the exact window and the main filter for a template that still uses `datePosted`. For example, a
10-hour query has a local 10-hour cutoff; a 24-hour query has none. Records the source relists can carry today's
`postedDate` and an older `postedTimeAgo`; they count as day precision and stay. The local comparison respects the precision of `postedDate`:

| Source time fields | Local comparison |
|---|---|
| Bare date (`YYYY-MM-DD`) | Day precision; exclude only when the whole supplied day is before the cutoff |
| ISO midnight with a consistent `postedTimeAgo` in seconds, minutes or hours | Exact timestamp |
| ISO midnight with missing, invalid, unsupported, conflicting or day/week-only relative text | Day precision |
| Non-midnight ISO timestamp with an absent or consistent relative label | Exact timestamp |
| Non-midnight ISO timestamp with a present but invalid, unsupported or conflicting relative label | Day precision, using the supplied date |
| Missing/invalid date or an unrecognized date format | Keep it; the time fields cannot establish that it is outside the window |

Relative labels are checked at collection time using their stated unit: “5 hours ago” means an age of at least
5 and less than 6 hours. They are never converted into a stored posting time. A placeholder such as
`2026-10-26T00:00:00.000Z` paired with “1 minute ago” therefore stays eligible when its day overlaps the window.
The raw payload remains unchanged. Only valid full calendar dates and ISO instants become `postedAt`: bare dates
store as UTC midnight, and ISO timestamps keep their supplied instant. Unsupported or invalid dates such as
`2026-10` and `2026-02-30` leave `postedAt` unknown (`null`). The day-end allowance is only for filtering. Relative-label
precision handling is specific to Apify; date validation is shared with Bright Data and Monid.

## Live smoke test
```bash
pnpm smoke:apify              # reads .env; one query, at most 10 results, about $0.005
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-apify.ts --limit 5
```
It spends money on your Apify account; it writes nothing to the database, and usage is shown only in the output.
