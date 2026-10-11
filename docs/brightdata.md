# Bright Data (first-priority LinkedIn channel)

The `linkedin-brightdata` channel fetches LinkedIn jobs through the Bright Data Web Scraper API "LinkedIn job listings - discover by keyword".

## Account and key
1. Sign up for a Bright Data account (free tier 5000 records per month, no card needed), and create an API key under Account settings.
2. Put the key in `.env`: `BRIGHT_DATA_API_KEY=...` (`.env` is gitignored; do not commit it or paste it into chat or logs).
3. Without a key the channel shows "Not configured"; the cascade skips it, sends no request, records no failure, and does not affect the circuit breaker, so the next LinkedIn channel takes over.

## Configuration (`data/config/sources.yaml` -> `linkedin.brightdata`)
| Key | Meaning |
|---|---|
| `enabled` | Switch |
| `free_records_per_month` | Free records per month (default 5000); used up first |
| `cost_per_1k_usd` | Price per 1000 records beyond the free quota (default 1.5; 0 = treat as free) |
| `monthly_budget_usd` | The most this channel may spend per month (counts only beyond the free quota); for the global cap see `paid_total_monthly_budget_usd` |
| `dataset_id` | Bright Data dataset ID (`gd_lpfll7v5hcqtkxl6l`) |
| `poll_interval_ms` / `timeout_ms` | Snapshot progress poll interval / the longest total wait from trigger to download complete (snapshot build + download), default 600000 (10 minutes). A timeout is recorded as a retryable failure, and the snapshot id is written to the log (the vendor keeps it for 30 days, so it can be retrieved later) |
| `country` | Country code for city queries |
| `remote_locations` | The locations remote queries use per `search.yaml: remote_scope` |
| `max_results` | Maximum results per query (at most 100 per input, Bright Data's limit) |

## How it works
- Each query = one trigger: keyword groups merged as `"A" OR "B"` (automatically split into several inputs over 200 characters), x one city (or remote location).
- Time window: <= 24 hours -> `Past 24 hours`, <= 7 days -> `Past week`, <= 30 days -> `Past month`. Windows shorter than the vendor's tiers (for example 10 hours) are filtered locally by `job_posted_date`; jobs without a posting date are kept.
- Usage is accounted by the number of records the snapshot actually delivered: billed usage is never discarded, and records dropped by the local time window or duplicates are counted too (they are not written to raw_postings). Before triggering, `limit_per_input` is computed from the remaining free records and remaining dollars, so normally the budget is not exceeded; when the budget is already empty it is `budget_exceeded` directly and the same query uses the next channel in the cascade. If the vendor ignores the limit and delivers a snapshot beyond the budget, those records are stored as usual and the actual usage is recorded truthfully; afterwards the channel has no headroom this month and later queries are taken over by the next channel in the cascade.
- The dataset has no "remote / hybrid / on-site" field; `workplace` is derived by the pipeline reading the JD text (see [Extraction](extraction.md)), and when it cannot be read it is `unknown` (nothing is guessed).
- Description: `job_summary` is one block of plain text ending with "Show more Show less"; `job_description_formatted` is HTML with paragraphs and lists, already added to the requested fields, and parsing prefers it. Older collected records do not have this field; the pipeline tidies them (`pipeline.yaml: description`).

## Live smoke test
```bash
pnpm smoke:brightdata            # reads .env; one query, at most 10 results
pnpm exec tsx --env-file=/path/to/.env scripts/smoke-brightdata.ts --limit 5
```
It consumes free quota (the vendor bills every record delivered for smoke tests and dry runs alike); it writes nothing to the database, and usage is shown only in the output and not counted toward the month's total.

## Notes
- Field names follow `GET https://api.brightdata.com/datasets/<dataset_id>/metadata`; requesting a field that does not exist makes the trigger return 500.
- When the vendor returns 429, do not retry immediately: Bright Data blocks IPs that accumulate 25 429s within 5 minutes. The trigger is not retried (a repeated trigger may be billed twice).
