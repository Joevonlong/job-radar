# Monid (third LinkedIn fallback)

`linkedin-monid` searches LinkedIn jobs through Monid's prepaid workspace wallet. The default endpoint is
`apify /harvestapi/linkedin-job-search`; Monid forwards the search keywords and location to its upstream provider.
The default cascade is Bright Data → Apify → Monid → session → guest. A channel without budget or with a
non-retryable failure hands the query to the next channel; a retryable failure ends that query for this cycle.

## Account and key

1. Create a workspace at [Monid](https://app.monid.ai) and create its API key.
2. Add `MONID_API_KEY=...` to `.env`, then restart the web and runner (`docker compose up -d web runner`). Keep the key out of YAML, Git, chat and logs.
3. Fund the workspace wallet as needed and **set a workspace spend cap in the Monid dashboard**.
4. Check the `linkedin-monid` card on `/sources` and its budget in `/settings` → channels.

The channel is enabled by default, but without a key it is shown as not configured and skipped without a failed run
or a circuit-breaker strike. Job Radar does not check the wallet balance or top it up automatically. Insufficient
credit or an inactive wallet lets the cascade move on. Requests use a bearer header and never follow redirects;
the allowed credential host is `api.monid.ai` ([configuration guards](configuration.md)).

## Configuration

Edit `data/config/sources.yaml` → `linkedin.monid`. Common fields, prices and timings are available in `/settings`.
`provider`, `endpoint` and `api_base_url` are protected: edit the file directly. Changing to an endpoint with a
different output shape also requires a matching parser; this channel supports harvestapi LinkedIn jobs only.

| Key | Default / meaning |
|---|---|
| `enabled` | `true`; without `MONID_API_KEY` no request is sent |
| `monthly_budget_usd` | `5`; no higher than `paid_total_monthly_budget_usd` |
| `throttle` | `{ min_delay_ms: 1000, max_delay_ms: 3000 }` between split runs |
| `max_results` | `300`; also limited by the search query and remaining budget |
| `api_base_url` | `https://api.monid.ai` |
| `provider` / `endpoint` | `apify` / `/harvestapi/linkedin-job-search` |
| `price_per_1k_usd` / `flat_fee_usd` | `1.0` / `0.001`; configured estimates, check the endpoint's current price |
| `poll_interval_ms` | `5000` |
| `timeout_ms` | `300000` before requesting a stop |
| `stop_grace_ms` | `60000` to wait for settlement after a stop |
| `country_name` | Empty: the market's English country name, appended to city queries |
| `remote_locations` | `worldwide: Worldwide`; missing home-country/region values follow the market |
| `date_posted` | `{ day: 24h, week: week, month: month, any: "" }`; empty omits the input key |
| `input_template` | `jobTitles: ["{keywords}"]`, `locations: ["{location}"]`, `maxItems: "{limit}"`, `postedLimit: "{date_posted}"`, `sortBy: date` |
| `remote_input` | `workplaceType: [remote]`, merged over the template for remote queries |

Templates, remote overrides and look-back values are edited in YAML. Keywords in a group become `"A" OR "B"`;
long groups split into separate runs. Every final input must contain exactly one nonempty title, one nonempty
location and a positive integer `maxItems` equal to that run's affordable limit. Zero would mean unlimited pages
to the actor and is refused before sending. Shorter time windows are also filtered locally by `postedDate`.
Remote facts come only from the posting, and only employer-provided salaries become salary facts.

## Accounting and stops

Before **each** run, the channel recalculates headroom in its own and the global budget, including that run's flat fee.
Monid has no server-side per-run cost cap: local result limits are estimates based on configured prices. Actual
charges are booked even if they slightly exceed the local budget; the dashboard spend cap is the additional guard.

Accounting happens before output validation or parsing, using `billedUnits` or the raw item count before deduplication
and local filtering. The USD amount is the maximum of settled `cost.value`, `billing.reportedCost` and
`billing.actualCost` (billing values are USD microdollars, divided by one million). Explicit zero settlements stay zero.
`billing.calculatedCost` is used only when there is no settled amount, with a warning. If amounts are absent or
malformed, the channel estimates from billed units or delivered items plus the flat fee; an empty successful run
still pays that fee. Failed, timed-out or unresolved runs without settlement or billed units use the full requested
limit conservatively, as does a successful response whose output is not an array. A normal terminal `BLOCKED` or
`STOPPED` response with no billing information is booked as zero. During cancellation, a terminal response without
usable cost fields is charged at the full requested limit conservatively, including `BLOCKED` and `STOPPED`.

An asynchronous run is polled to a final status. A timeout sends one stop request, then continues polling during
`stop_grace_ms`; a 409 stop response is rechecked because the run may already have completed or still be running.
Completed results are retained and charged normally. An unresolved stop or lost run response is accounted for at
the requested limit and logged with the run ID when available. Cancelling a cycle sends an independent, short-timeout
stop request and records settlement or a conservative estimate before propagating cancellation. A billable run is
never retried automatically. Earlier results from a split query survive a later failure or budget stop.

Raw items are retained even when parsing fails. Items without a LinkedIn job ID use a stable `unidentified:<sha256>`
quarantine ID and are marked `parse_failed`; they never merge with real LinkedIn jobs.

## Smoke test

```bash
pnpm smoke:monid --discover       # only discover + inspect; no billable run
pnpm smoke:monid                  # reads .env; one query, at most 10 results
pnpm smoke:monid --limit 5 --group targets --location "Example City"
```

The paid smoke test costs wallet credit (at the configured prices, up to about USD 0.011 for 10 results).
It writes no database or persisted monthly usage. It prints counts, `billedUnits`, `cost`, every `billing` field
including `calculatedCost`, `runId`, `stoppable`, output shape and salary-source flags. Compare with the workspace's
charge record. Check that OR titles match the intended search, `maxItems` is respected, output is an array, and
`salary.providedByEmployer` / `compensationSource` match the provider's actual response. Groups requiring multiple
runs are refused. `--discover` lists LinkedIn job endpoints and their prices, including `price.type`.

## Upgrade, disable and rollback

The sources migration is **3 → 4**. It preserves an existing Monid block; otherwise it adds the block with budget
`min(5, global cap)` and leaves the global cap unchanged. Only the exact previous default cascade gets Monid inserted
after Apify and enabled. With a customized, reduced or missing cascade, the new block has `enabled: false`;
add Monid to the cascade and enable it in `/settings` if wanted. The migration runs once; deleting the cascade entry
afterwards does not add it back. Keep the config block and set `enabled: false`
to disable the channel; deleting a required block makes the current config invalid.

To disable without rolling back code, set `linkedin.monid.enabled: false`. An enabled LinkedIn channel outside the
cascade is scheduled independently, so removing `linkedin-monid` from the cascade does not disable it.
Before rolling code back below this version, **restore `sources.yaml` from `data/config/.backup/<timestamp>/`**.
Alternatively, remove the Monid block and cascade entry and set `config_version: 3`. Older code rejects version 4.
The deploy script migrates configuration before switching services, so schedule deployment outside collection times;
if deployment fails after migration, restore the backup before restarting the older code. See [configuration](configuration.md).
