# AI usage statistics

Every AI call leaves one row in `ai_usage`, and `/sources/ai-usage` summarises them by time range. This page explains what is recorded, how it is calculated, how to use it, and **the configuration to add when upgrading**.

## What is recorded

One row per model request (including retries after unacceptable output, timeouts and errors). Cancelled requests and requests skipped by routing (cooldown, disabled, over budget) are not calls and are not recorded.

| Column | Meaning |
|---|---|
| `model` / `model_source` | The model name reported in the reply; `call` = reported by the call or specified by us; `cli_default` = codex had no model specified, so it is taken to be the one marked `cli_default` in `models.yaml`; `assumed` = a model assumed for old records by an earlier version. Empty for old records and unknown models |
| `tokens_in` / `tokens_out` | Total input / output (input includes cache reads and writes, output includes reasoning); **empty = the provider did not report it, not 0** |
| `tokens_in_cached` / `tokens_in_cache_write` / `tokens_out_reasoning` | Subsets of the two numbers above; empty = not broken down |
| `duration_ms` | Duration of one model call |
| `outcome` / `error_kind` | `ok` / `invalid_output` / `failed`; failed rows carry an error kind (timeout, rate limit, login invalid, network, provider error, ...). The original error text is not stored |
| `cost_estimate` | **Actual spend**: API at `price`, subscription = 0; the monthly budget only adds up this column |
| `equivalent_cost_usd` | **Equivalent API cost**: what the same tokens would cost at API list prices. API call = actual spend; subscription CLI = computed from `equivalent_price`; empty if there is no price or the tokens are unknown |
| `job_id` | The job a scoring, signal or translation call belongs to (set to empty after the job is deleted) |

Both costs are calculated and stored **at write time** using the `models.yaml` in effect then; changing prices later does not rewrite history. Rows from before the migration have these new columns empty (shown as "legacy records" on the page).

## Prices: `price` and `equivalent_price`

- `price`: for API providers only; real billing, counts toward the monthly budget. It can have `cached_input_per_mtok` (cache-hit input) and `cache_write_per_mtok` (input written to cache); if omitted, `input_per_mtok` is used (conservative, as before).
- `equivalent_price`: for subscription CLIs only (claude-cli / codex-cli); used only for statistics and never counts toward the budget. The keys are the same as `price`, and in addition **`source` is required** (origin and date). Writing it on an API model is rejected by `pnpm config:check`.
- Pricing: `(input − cache read − cache write) × input price + cache read × cache read price + cache write × cache write price + output × output price`.
- The CLI's own cost estimate (claude's `total_cost_usd`) is not used as the equivalent cost; the basis is uniformly the `equivalent_price` in the catalog. You can use `total_cost_usd` from the output of `claude -p --output-format json` to check that a price was entered correctly.
- All amounts are in US dollars, with no conversion to other currencies.

## The page `/sources/ai-usage`

Read-only; it starts no AI calls. The time range (today / 7 days / 30 days / this month / custom, in the time zone of `schedule.yaml`, including today), the filters (click a row in the three breakdown tables, remove with ✕ on the chip), the metrics and the page number are all in the URL, so they survive a refresh and when the link is shared.

- Summary: equivalent API cost, actual spend, savings (equivalent − actual, counting only calls that have an equivalent cost), calls, tokens. Calls without a token count or without an equivalent price are left out of the totals, and the block states how many there are.
- A per-day stacked chart (by provider), three tables by model / provider / task, and a per-call detail list (the job title links to `/jobs/<id>`).
- When cache / reasoning tokens are unknown (old records lack these two columns), 0 is not written: the summary and detail tables show "known total + N unknown", and "unknown" when all are unknown; amounts are always written with `$` (the same on the Chinese and English pages); clicking "Custom" pre-fills the date boxes with the page's current time window; the footnote for missing equivalent cost separates "model unknown" from "model has no equivalent price".
- "Export CSV": the detail rows under the current range and filters, at most `csv_max_rows` rows (newest first), UTF-8 with BOM, unknown values as empty cells.
- Settings are in the `ai_usage` block of `data/config/ui.yaml` (default range, longest custom range in days, rows per page of the detail list, CSV cap); it runs fine if the file has no such block.

## Configuration to add

Older code with a strict schema does not recognise `equivalent_price`, cache prices or the `ai_usage` block of `ui.yaml`. If those keys are in the files before the code that understands them is running, the ai-worker cannot read the catalog (API providers are skipped) and the settings page reports an error. So the order is: upgrade and deploy the new code (`scripts/ops/deploy.sh`) → add the two blocks below to the files → `pnpm config:check` → commit the configuration change separately. To roll back, revert that configuration change first.

### `data/config/models.yaml` (add `equivalent_price` to the matching model entries, leave the rest alone)

The prices were checked against the official price lists on 2026-10-08: Anthropic (https://platform.claude.com/docs/en/about-claude/pricing); OpenAI (`gpt-6.1-sol` standard price, from OpenAI's model / pricing pages, cross-checked via search results). **Note**: the cache read for Sonnet 5.5 is $0.10 (0.05× the input price, not Sonnet 5's $0.20).

```yaml
  claude-cli:
    label: Claude Code CLI
    models:
      - id: claude-haiku-4-5
        label: Claude Haiku 4.5
        equivalent_price: { input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25, source: "Anthropic API pricing (5 min cache write), platform.claude.com, checked 2026-10-08" }
      - id: claude-sonnet-5-5
        label: Claude Sonnet 5.5
        equivalent_price: { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5, source: "Anthropic API pricing (5 min cache write), platform.claude.com, checked 2026-10-08" }
      - id: claude-opus-5-5
        label: Claude Opus 5.5
        equivalent_price: { input_per_mtok: 4, output_per_mtok: 20, cached_input_per_mtok: 0.2, cache_write_per_mtok: 5, source: "Anthropic API pricing (5 min cache write), platform.claude.com, checked 2026-10-08" }
  codex-cli:
    label: Codex CLI
    models:
      - id: gpt-6.1-sol
        label: GPT-6.1 Sol
        cli_default: true
        equivalent_price: { input_per_mtok: 2, output_per_mtok: 10, cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5, source: "OpenAI API pricing, standard tier (prompts up to 272K), openai.com / developers.openai.com, checked 2026-10-08" }
```

Optional: add cache prices to the `price` of the two `anthropic` models (current anthropic calls do not use caching, so the result is the same either way): Haiku 4.5 `cached_input_per_mtok: 0.1, cache_write_per_mtok: 1.25`; Sonnet 5.5 `cached_input_per_mtok: 0.1, cache_write_per_mtok: 2.5` (check against the models actually written in `config/models.yaml`; edit your copy `data/config/models.yaml`, made by copying the shipped file first, which then replaces the shipped list entirely).

### `data/config/ui.yaml` (add at the end of the file)

```yaml
# AI usage page (/sources/ai-usage): only affects how this page is displayed
ai_usage:
  # default time range when the page is opened: today | 7d | 30d | month (this month)
  default_range: 30d
  # the longest custom range, in days
  custom_max_days: 366
  # rows per page of the call detail list
  log_page_size: 50
  # the most rows "Export CSV" exports (when exceeded, only the newest this many rows are exported)
  csv_max_rows: 20000
```

## Troubleshooting

- "N calls have no token count" in the summary: the CLI reply carried no usage (the format changed, or that model does not report it). By design this is recorded as unknown; after upgrading the CLI, re-record the fixtures under `tests/fixtures/ai/`.
- "N calls have a model with no equivalent price": add `equivalent_price` to that model in `models.yaml`. It applies to new calls; older rows keep their empty value.
- `pnpm ai:probe` additionally prints cache / reasoning tokens, duration and equivalent cost (`equiv≈`) on each line.
