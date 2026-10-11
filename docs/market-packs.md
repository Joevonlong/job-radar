# Market packs

[English](market-packs.md) | [中文](market-packs.zh.md)

Job Radar works in one **market**: the country you look for work in. The market decides how locations are read, which
remote jobs are in scope, which local-language requirement is read from a posting, which currency salaries are
compared in, and which job boards run. The data behind it (countries, regions, cities, rule phrases) lives in **market
packs**, not in the code.

## Choosing the market

`data/profile/preferences.yaml`:

```yaml
market:
  pack: de            # a directory of config/packs/
  # country: DE       # home country (ISO 3166-1); default: the pack's
  # currency: EUR     # base currency (ISO 4217); default: the pack's
  # home_language: de # local language (ISO 639); default: the pack's
```

The same block is the **Market** section at the top of "What I want" on the profile page (/me). The `generic` pack names
no country, currency or language, so with it all three must be set (`pack: generic, country: US, currency: USD,
home_language: en`). A market that cannot be resolved (unknown pack, broken pack file, missing value) is not saved from
the page; in a hand-edited file it stops every market step until it is fixed (there is no silent fallback).

Check what is in effect:

```bash
pnpm market:show        # pack, country, currency, language step on / off, channels of this market
pnpm config:check       # validates every pack and the market of preferences.yaml
pnpm run doctor --only config.market
```

## What follows the market

| Area | Behaviour |
|---|---|
| Locations | A location that names a country gets that country's code (`Remote - USA` → US, `Dublin, CA` → US). The city before the home country's name (`Gütersloh, Germany`) is read only in the home market. |
| Remote scope | `none`, `home_country`, `worldwide`, or `{region: [eu, CH, …]}` (named regions and ISO countries) in preferences.yaml and search.yaml. Old values: `eu_hire_in_de` = `home_country`, `eu_any` = `{region: [eu]}`. |
| Local language | When the pack has requirement rules for its language and `home_language` is that language, the level a posting requires is read and a level above yours (me.yaml `languages`) costs points (ai.yaml `scoring.language_penalty`). Otherwise the step is off: no level is read, nothing is deducted, the scoring prompt does not ask for it, and the pages hide its filter and badges. |
| Base currency | Salary floor, "minimum salary" filter, statistics and the high-pay threshold are in the market's currency. Amounts in other currencies are converted with pipeline.yaml `salary.fx_pivot` + `fx_rates`; an amount in a currency without a rate is never compared. |
| Channels | A channel with `markets: [DE]` in sources.yaml runs only in those markets; elsewhere it is shown folded under "Other markets" and is not counted as a failure. Country parameters left empty (`country`, `country_name`, `country_indeed`) and remote-location keys left out follow the market. |

After changing the market, new postings follow it right away. Jobs already stored keep what they were given until you run
`pnpm reprocess`.

## Pack layout

A pack is a directory `config/packs/<id>/` (shipped). A copy in `data/config/packs/<id>/` replaces the shipped pack as a
whole (product updates of that pack then no longer apply; `pnpm run doctor` reminds you). Only `pack.yaml` is required.

| File | Contents |
|---|---|
| `pack.yaml` | `id` (= directory name), `name`, and the market defaults: `country`, `currency`, `language`, `locale` (letter case of place names), `region` (the named region the country belongs to), `default_channels` (the job boards of this market: the wizard lists them with a "local" mark and /me offers to "turn them on"; scraping channels such as StepStone or XING are never switched on by it without your confirmation, see [sources.md](sources.md#scraping); the `de` pack lists arbeitsagentur, stepstone, xing and [arbeitnow](sources.md#arbeitnow)). |
| `geography.yaml` | `countries` (code, English name, optional `currency` the setup wizard proposes for the country, `aliases`, `indeed` name, optional `pattern`, `match: false` for names that are common words), `regions` (name, countries, `patterns`), `cities` (spelling → canonical name + country), `subdivision_codes` (`US: [TX, NY, …]`), `non_city_labels`, `non_city_words`, `city_aliases`, `metro_areas`, `metro_regions`, `country_level_patterns`, `transliterations`. |
| `language.yaml` | `stopwords` per language (to tell a description's language) and `requirement`: the rules that read the required level (`word_pattern`, `cefr_name_pattern`, `cefr_connectors`, `level_rules`, `optional_patterns`, `not_required_patterns`, …, `prompt_examples` for the scoring prompt). |
| `rules.yaml` | Language-specific pieces of pipeline.yaml: `company.legal_suffixes` / `agency_names`, `agency.*_patterns`, `contract.*`, `salary.currencies` (how currencies are written), `filter.generic_location_patterns`, `filter.remote.*`; `closed_posting.phrases`: sentences (regex, case-insensitive; only the safe subset described under "Recheck of watched jobs" in configuration.md: no `*`, `+` or `{n,}`) on a posting page that say it no longer takes applications, used by the recheck of starred / followed jobs (see usage.md "Closed jobs"). |

The `generic` pack is always loaded: the world country table, the regions `eu`, `eea`, `europe`, `dach`, `nordics`,
the city table, US state codes and English rules. The market's own pack is added on top.

## How the effective pipeline config is built

The code reads `pipeline.yaml` together with the packs (`loadPipeline()`):

- lists: your pipeline.yaml entries first, then generic, then the market's pack, duplicates removed;
- maps (`city_aliases`, `metro_areas`, …): your keys win over the pack's;
- `language.requirement`: the whole block comes from the market's pack (the order of its rules matters); a
  `language.requirement` in your pipeline.yaml replaces it;
- `salary.local_currencies`: left out = the market's currency;
- `closed_posting.phrases`: generic's and the market pack's lists united; your own go in `ui.yaml`
  (`job_checks.closed_recheck.extra_phrases`), not in pipeline.yaml.

So pipeline.yaml keeps only what you add yourself. The config migration of pipeline.yaml removed the entries that are
now in the packs.

## Writing a pack

1. Copy `config/packs/de/` to `data/config/packs/<id>/` and set `id`, `name`, `country`, `currency`, `language`,
   `locale`, `region`, `default_channels` in `pack.yaml`.
2. `geography.yaml`: the home country's metro areas, the texts that name only the country, transliterations of letters
   that sources drop. Countries and regions come from `generic`; add a country here only when the table lacks it.
3. `language.yaml`: stopwords of the language and, if you want the local-language step, a `requirement` block. Without
   it the step stays off.
4. `rules.yaml`: legal-form suffixes, agency and contract phrases, how the currency is written, and the "no longer
   accepting applications" sentences of the language (`closed_posting.phrases`; keep them specific: a hit marks a job
   possibly closed).
5. Set `market.pack: <id>` and run `pnpm config:check`, `pnpm market:show`, then `pnpm reprocess`.
6. To see what changed: `pnpm market:regress snapshot --out before.json` before, the same with `after.json` after the
   reprocess, then `pnpm market:regress compare before.json after.json`. It prints counts per field and code-value
   changes (country, level, filter reason), never job text.

## Database column names

The columns keep their names; their meaning is now "the local language of the market":

| Column | Meaning |
|---|---|
| `jobs.german_level_required` | Level of the local language the posting requires (`none`, `preferred`, `A1`…`C2`, `unknown`) |
| `scores.german_penalty` | Points taken off for the local language |
| `scores.german_level`, `german_level_ai`, `german_level_source` | Level used for the deduction, the AI's reading, how it was settled |

Salaries in `jobs.salary_json` and T1 signals carry `basePerYear` + `baseCurrency`; rows written while the base was always
EUR are read as EUR.

## Renamed configuration keys

The config migrations (`pnpm config:migrate --write`) rename them; old files keep working in memory until then.

| File | Before | Now |
|---|---|---|
| preferences.yaml | `salary_floor_eur_year` | `salary_floor_year`, plus `market` |
| preferences.yaml, search.yaml | `remote_scope: eu_hire_in_de / eu_any` | `home_country` / `{region: [eu]}` |
| sources.yaml | `remote_locations.eu_hire_in_de / eu_any` | `home_country` / `region`; German boards get `markets: [DE]` |
| pipeline.yaml | `language.german_*`, `salary.fx_to_eur` | the DE pack's `requirement`; `salary.fx_pivot: EUR` + `fx_rates` |
| ai.yaml | `scoring.german_penalty`, `priority.weights.german_gap` | `language_penalty`, `language_gap` |
| insights.yaml | `salary_bucket_eur`, `salary_bucket_cap_eur` | `salary_bucket`, `salary_bucket_cap` |
| interests.yaml | amount category `amount.min_annual_eur`, `amount.rough_fx_to_eur`; saved views `filters.hideGerman` | `amount.min_annual`, `amount.rough_fx` (base currency); `filters.hideLang` |

`amount.assume_currency` (the currency of an amount that names none) may be `market`: the market's base currency. The
/jobs and Today URLs use `hideLang`; old links with `hideGerman` still work.
