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
| `rules.yaml` | Language-specific pieces of pipeline.yaml: `company.legal_suffixes` / `agency_names`, `agency.*_patterns`, `contract.*`, `salary.currencies` (how currencies are written), `filter.generic_location_patterns`, `filter.remote.*`; `closed_posting.phrases`: sentences (regex, case-insensitive; only the safe subset described under "Recheck of watched jobs" in configuration.md: no `*`, `+` or `{n,}`) on a posting page that say it no longer takes applications, used by the recheck of starred / followed jobs (see usage.md "Closed jobs").; `ghost`: signs that a posting is not a real opening (see [Ghost job patterns](#ghost-job-patterns)); `visa`: what a posting says about visa sponsorship (see [Visa patterns](#visa-patterns)). |

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
- `ghost` and `visa`: generic's and the market pack's lists united (generic first); pipeline.yaml has no patterns of its
  own for them.

So pipeline.yaml keeps only what you add yourself. The config migration of pipeline.yaml removed the entries that are
now in the packs.

## Ghost job patterns

The `ghost` section of `rules.yaml` holds the phrases of the [ghost job check](ghost-jobs.md). `generic` has the English
ones, `de` the German ones. Every entry with an `id` (lower-case letters, digits and `_`) keeps that id in the stored
reason, so the checks card and `pnpm ghost:check` can say which phrase matched.

| Key | What it is |
|---|---|
| `repost_label_patterns` | The source's own "reposted" label ("Reposted 2 weeks ago", "Wiedereingestellt"); `{id, pattern}` |
| `evergreen_patterns` | The JD says it is a talent pool or always open ("for our talent pool", "always hiring", "Initiativbewerbung (m/w/d)"); `{id, pattern, check_negation}`. `check_negation: false` marks a phrase that is a negation itself ("no specific opening", "keine konkrete Stelle") |
| `responsibility_patterns` | A heading that opens the duties of the role ("Responsibilities", "What you'll do", "Deine Aufgaben"), tested only against heading-shaped lines; `{id, pattern}` |
| `negation_cues` | Words that cancel an evergreen phrase: inside it, within `pipeline.yaml job_checks.ghost.negation_words_before` words before it, within `negation_words_after` words after it in the same clause, or in the heading of its list |
| `clause_breaks` | Where that clause ends (";", " but ", " aber ", "and we …") |
| `exclude_context` | A sentence that matches (or the question right before it) does not count: the employer's product or customers, a duty of the role, the footer of a real posting, a conditional, a privacy note |
| `abbreviations` | Abbreviations whose dot does not end a sentence |
| `prefilter` | A quick first look: a JD or line with no match is not searched for evergreen phrases |

As for visa, **every phrase an `evergreen_patterns` entry can match must contain a `prefilter` match**, or it is never
seen; `pnpm config:check` warns about a pattern whose own text has none, and names an invalid regular expression by its
path (`ghost.evergreen_patterns[2]`). Changing the patterns checks every job again in the next cycles; preview with
`pnpm ghost:check`.

## Visa patterns

The `visa` section of `rules.yaml` holds the phrases of the [visa check](visa-sponsorship.md). `generic` has the English
ones, `de` the German ones; both are always used in the German market.

| Key | What it is |
|---|---|
| `offered` | Support is mentioned ("We offer visa sponsorship", "Relocation-Support") |
| `not_offered.no_sponsorship` | Sponsorship is refused ("We are unable to offer visa sponsorship") |
| `not_offered.permit_required` | A permit the candidate already holds is required ("You must hold a valid work permit") |
| `permit_alternatives` | Next to a `permit_required` phrase, an alternative makes the sentence unclear ("…or are eligible for an EU Blue Card") |
| `mention_terms`, `mention_context` | A visa word with a context word in the same sentence is an unclear mention |
| `negation_cues` | Words that make an `offered` phrase unclear ("not", "kein…"): inside it, within `pipeline.yaml job_checks.visa.negation_words_before` words before it, or within `negation_words_after` words after it in the same clause |
| `clause_breaks` | Where that clause ends ("; ", " but ", " aber "): a negation beyond it does not count. A comma or a colon does not end it ("Relocation support: No") |
| `exclude_context` | A sentence that matches is not about the candidate's visa ("sponsored events", "Visa/Mastercard", "our customers with visa applications") |
| `exclude_companies` | Company names (normalized) that are visa words: only patterns marked `combo: true` count for them |
| `abbreviations` | Abbreviations whose dot does not end a sentence ("z.B", "inkl") |
| `prefilter` | A quick first look, see below |

`offered`, `not_offered.*` and `mention_terms` take `{pattern, combo, list_item}` entries: `combo: true` marks a pattern
that joins the visa word with its context, so it still counts for a company named like a visa word; `list_item: true` one
that counts only on a list item of its own (the bare noun "- Visa sponsorship"), never on a heading ("## Visa
sponsorship" followed by "Not available"). Patterns are regular
expressions with the flags `iu`; `pnpm config:check` names an invalid one by its path (`visa.offered[3]`).

**`prefilter`**: the visa deal-breaker reads every open job in every filter run, so a text or sentence that matches none
of the prefilter patterns is skipped without running the others. That works only when **every phrase `offered`,
`not_offered` or `mention_terms` can match contains a prefilter match**: a phrase with a new key word ("Aufenthaltstitel")
needs that word in `prefilter` too, or it is never seen. Only the lines with a prefilter match (and the heading above
them) are cut into sentences. `pnpm config:check` warns about a pattern whose text has no prefilter match (a rough check:
it reads the pattern, not what it matches). Leave `prefilter` empty to read every sentence (slower).

After changing the patterns, `pnpm visa:scan` previews what would change and `pnpm visa:scan --write` stores it; the
cycle also rechecks every job, because the patterns are part of each result's input.

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
   Visa phrases of the language go under `visa` (see [Visa patterns](#visa-patterns)) and ghost job phrases under `ghost`
   (see [Ghost job patterns](#ghost-job-patterns)); without them the checks read only English phrases.
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
