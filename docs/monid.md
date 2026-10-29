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
Only valid full calendar dates and ISO instants become `postedAt`. Invalid dates such as `2026-02-30` stay unknown
(`null`) in collection and normalization; the raw payload is kept unchanged.
Remote facts come only from the posting, and only employer-provided salaries become salary facts.
The location label is preserved even for regions such as EMEA; country codes must be assigned ISO 3166-1 alpha-2
codes. The parsed location code takes precedence, while placeholders such as `oo` remain unknown.

`POST /v1/run` sends `{ "provider": "apify", "endpoint": "/harvestapi/linkedin-job-search", "input": { "body": <actor input> } }`.
Validation applies to the actor input inside `input.body`; GET run responses echo that wrapper. Monid also supports
optional `input.queryParams` and `input.pathParams`, which this actor does not need.

## How it works

Monid always keeps the base window; automatic [catch-up](sources.md#catch-up-windows) is disabled because its date ranges
are coarse and results are not newest first. It will be enabled only after exact-window requests and newest-first
results under the channel's active settings have been measured. A stretched window in a future manual backfill could
fetch more records per query and increase per-record charges.

## Accounting and stops

Before **each** run, the channel recalculates headroom in its own and the global budget, including that run's flat fee.
Monid has no server-side per-run cost cap: local result limits are estimates based on configured prices. Actual
charges are booked even if they slightly exceed the local budget; the dashboard spend cap is the additional guard.

Run, inspect and per-result discovery prices use nested money objects:
`{ "type": "PER_RESULT", "amount": { "value": 0.001, "currency": "USD" }, "flatFee": { "value": 0.001, "currency": "USD" }, "notes": [] }`.
The amount is per result (USD 1.0 per 1,000); the optional flat fee is per run. Extra fields are allowed, and non-USD
money is never interpreted as USD. A normal successful run can settle with `cost: { value, currency: "USD" }` and
`billedUnits` alone, without a `billing` object: two results at these prices settle at USD 0.003.

Accounting happens before output validation or parsing, using `billedUnits` or the raw item count before deduplication
and local filtering; postings discarded as outside the window are still billed. The USD amount is the maximum of
settled `cost.value`, `billing.reportedCost` and `billing.actualCost` across all responses for the run, including a 409
stop body and subsequent GETs
(billing values are USD microdollars, divided by one million). Explicit zero settlements stay zero when no larger
settlement was observed. The latest valid `billing.calculatedCost` is used only when no settled amount was observed,
with a warning. Cost extraction also applies to responses with an unknown status. If amounts are absent or
malformed, the channel estimates from billed units or delivered items plus the flat fee; an empty successful run
still pays that fee. Failed, timed-out or unresolved runs without settlement or billed units use the full requested
limit conservatively. A `COMPLETED` response with output that is not an array and no usable amounts or billed units
also uses the full limit unless a valid non-2xx, non-404 provider error is confirmed; missing or invalid
`providerResponse` is conservative too. A normal terminal `BLOCKED` or `STOPPED` response with no billing information
is booked as zero. During cancellation, if no valid settled or calculated cost was observed in any response, the full
requested limit is charged conservatively, including when cleanup returns `BLOCKED` or `STOPPED`.

An asynchronous run is polled to a final status. A timeout sends one stop request, then continues polling during
`stop_grace_ms`; a 409 stop response is rechecked because the run may already have completed or still be running.
Completed results are retained and charged normally. An unresolved stop or lost run response is accounted for at
the requested limit and logged with the run ID when available. Cancelling a cycle sends an independent, short-timeout
stop request and records settlement or a conservative estimate before propagating cancellation. A billable run is
never retried automatically. Earlier results from a split query survive a later failure or budget stop.

The HTTP 502 → non-retryable `unknown` and HTTP 503 → `budget_exceeded` mappings apply to the **initial run request**.
A fully read HTTP 503 rejection means execution was refused (for example, an inactive wallet) and is not charged.
Other POST 5xx responses, including 502, are charged conservatively at the full requested limit when no usable cost
was observed. Unreadable or truncated POST responses are still charged conservatively, including HTTP 503.
Once a run is accepted, polling HTTP 408, 429 and 5xx is transient: the run is recovered
or stopped first. Persistent 502/503 through the deadline and stop grace period ends in a retryable `network` failure.
If polling fails non-transiently before a stop was requested, the client sends one best-effort independent stop with
a short timeout before giving up; the original failure and once-only accounting are preserved.

Raw items are retained even when parsing fails. Items without a LinkedIn job ID use a stable `unidentified:<sha256>`
quarantine ID and are marked `parse_failed`; they never merge with real LinkedIn jobs.

Records filtered out locally remain in the [delivery ledger](sources.md#paid-delivery-ledger).

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
runs are refused. `--discover` reads catalog entries independently, skips unknown shapes, lists LinkedIn job endpoints
with provider and price type (including matrix/tiered prices), prints the per-result amount and flat fee, and inspects
each endpoint. The configured endpoint is inspected even when it is absent from the discovery results. Both modes
warn when its inspected USD per-result or flat price differs from `price_per_1k_usd` / `flat_fee_usd`; at the prices
above, those settings must be `1.0` / `0.001`. Unsupported currencies or price models are reported without a USD comparison.

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
