# Signal categories: pay, benefits and your own signals

The `signals` step of a processing cycle, and the `signals` subtask under the `ai` step, pick compensation signals out of the JD, each with a quote from the original text. The categories, word lists, weights and caps are all in `interests.yaml` of the user config directory.

## Signal categories

Signals are grouped into **categories**. On `/interests` you can add, delete, rename and reorder them (at most 12), or edit `signals.categories` in `interests.yaml` directly. The order of the list is the order they are shown and sorted in. Every category has a kind:

| Kind | What it finds | Notes |
|---|---|---|
| `amount` | Stated amounts | Patterns find a figure; it is converted to a year and compared with the salary floor. At most one. Its settings are under `amount:` (edited in the YAML only) |
| `keyword` | Keywords | `keywords` (literal words), `patterns` (regular expressions), `exclude`; reviewed by the AI |
| `tag` | Benefit-like tags | `tags` (literal words), `tag_patterns` (a name + a pattern); rules only, never sent to the AI |

Every category also has: `id` (starts with a letter, at most 24 characters; it cannot change once saved, nor can `kind`), `label` (`zh` / `en`, at least one), `icon` (at most 2 characters), `color` (from the palette: amber, teal, coral, blue, olive, violet, slate, pink, neutral), `weight` (points for a hit), `high_value` (a high-value signal, see below), `ai_confirm_only` (a rule hit is only a candidate until the AI confirms it; not for `tag` categories) and `ai_definition` (what the AI is told the category means, in English).

The five default categories are the former tiers, with the same ids:

| id | Kind | Content | Badge | Default bonus | High value |
|---|---|---|---|---|---|
| T1 | amount | A specific stated amount (converted to annual salary) | 💰 €85–105k | 10 | yes |
| T2 | keyword | Equity, stock options, employee share ownership | 📈 Equity | 8 | yes |
| T3 | keyword | Qualitative descriptions such as "competitive salary" | 🏅 Competitive | 3 | no |
| T4 | keyword | Bonus, 13. Gehalt, profit sharing (needs the AI's confirmation) | 🎁 Bonus | 2 | no |
| tag | tag | Deutschlandticket, JobRad, ≥ 28 days of vacation… | Small tag | 0 | no |

Rank value = match score + min(sum of the categories' bonuses, `bonus_cap`); each category counts only once per job, and a `tag` category only with a weight above 0. The amount category earns its bonus only when "the stated amount counts as high pay": the upper end of the annual salary (in the market's base currency; amounts in other currencies are converted at the rough rates in `amount.rough_fx`, and a currency in neither table cannot be compared and is treated as high pay) must be no lower than `amount.bonus_requires_at_least` (`salary_floor` = `salary_floor_year` in `preferences.yaml`, the default; a number = at least that much per year in the base currency; `none` = any stated amount counts). Amounts below the threshold are still extracted and shown, but the badge is grey with no bonus and they are not a high-value signal. An amount that "may be pay for another region" (see below) earns `amount.other_region_weight` points instead (default 0: no bonus, not a high-value signal); if the same job also has a local amount, the local one is used. After changing weights, `bonus_cap` or the salary floor, `scores.signal_bonus` and `rank_value` are recalculated right away on save, with no AI needed.

### High-value signals

Categories with `high_value` (by default T1 and T2) are high-value signals. They decide the "High-value signals only" quick filter of the lists (URL parameter `high=true`; old links with `t12=true` still work and are read as `high=true`), the lower push threshold (`push_min_score_high_value` in `notify.yaml`), what counts as "qualified" on Today, and the high-value count on the statistics page. An amount must also reach the salary floor and be local pay. Without any high-value category the button is hidden and the push uses `push_min_score` only.

### What triggers a re-scan or a new AI review

- Names, icons, colours, weights, high value: no re-scan, no AI; the bonuses are recomputed right away.
- Words, patterns, exclusions, `ai_confirm_only`, the order of the categories, adding or deleting a category: the JDs are scanned again in the next cycle (the rule fingerprint changed).
- AI definitions, adding or deleting an amount / keyword category, `ai_confirm_only`: the AI prompt gets a new version, and jobs on the shelf are reviewed again over the next cycles, within the per-cycle limit. With the five default categories the prompt is word for word what it was before categories existed (version `signals-v1`).

### Deleting and restoring

A deleted category moves to `signals.retired_categories` with its whole definition. Its signals stay in the database but are no longer shown, scored, filtered or pushed; the confirmation says how many signals and jobs that concerns. A deleted category can be restored from "Deleted categories"; the next cycle extracts its signals again. A deleted id cannot be used for a new category.

### Upgrading from the old format

`interests.yaml` and `notify.yaml` are at format version 2. An old file (version 1: `signals.T1..T4`, `benefit_tags`, `weights`) is converted in memory when it is loaded and works as before; `pnpm config:migrate` previews the change and `pnpm config:migrate --write` backs the file up and writes it (comments kept). The five default categories are exactly the former tiers, so the upgrade neither re-scans every job nor sends every job to the AI again.

## Add your own interest point

Example: you want to know which employers give you a large or unlimited AI token budget, or pay for Copilot / Claude /
Cursor seats. That is a signal category of kind `keyword`; nothing new is needed.

**Category or scoring criterion?** A category gives a badge with a quote from the JD, can be filtered on, adds its
`weight` to the rank value and, with `high_value`, counts for the lower push threshold. A line in
`ai.yaml: scoring.criteria.nice_to_have` ([settings.md](settings.md#ai-tab-scoring-criteria)) only nudges the AI's match
score: no badge, no filter, and changing it re-scores every job. Use a category for something you want to see and filter
on; use `nice_to_have` for a vague preference.

**Step by step**

1. `/interests` → **Add category** → **Start from**: pick the preset "AI tools / token budget" (or "Open-source time"),
   or "Blank category" and the kind "Keywords". A preset fills in the names, icon, colour, weight, the AI definition and
   the words, in English and in the language of your market (German for the Germany pack). The presets live in the
   shipped `config/signal-presets.yaml`; choosing one only fills in the form. An id that is taken gets `_2`.
2. Write the **AI definition** in English and say what counts and what does not:
   `The employer pays for AI tools for the employee ... Not: building AI products, or "experience with AI tools" asked of the candidate.`
3. Optional: **words and patterns**, in every language your jobs are written in (the rules do not translate). They find
   candidates without AI; `exclude` vetoes phrases like "experience with Copilot".
4. **Weight** (points, within the cap) and **High-value signal**.
5. **Try on recent jobs**: runs the words and patterns over the newest `limits.preview_jobs` open jobs (default 500), shows
   how many jobs they hit with up to three quoted examples, and how many jobs the AI will review again after saving and in
   about how many cycles. No AI is called and nothing is saved. The check stops after `limits.preview_time_budget_ms`
   (default 1500 ms) and then marks the result as partial.
6. **Save**. The notice repeats the review estimate.

**How it matches.** The rules find candidates from the words (no AI cost). The AI review of every unfiltered open job
reads the JD against each category's definition: it confirms or rejects the candidates and adds hits the words missed,
in any language. A category with **only a definition** and no words works too: with
`limits.ai_review_without_candidates: true` (the default) jobs without rule hits are still sent to the AI, which finds it
by meaning; the category row says "AI only". With that limit off such a category can never match: the row shows a
warning and `pnpm config:check` prints `interests.semantic_only_unreachable`. Every signal needs a quote that is really in
the JD; a quote that is not is dropped.

**When it takes effect, and the cost.** A new keyword category changes the AI prompt version: jobs on the shelf are
reviewed again from the next cycle, at most `ai.yaml: per_cycle_limit` per cycle; filtered-out and closed jobs are not.
Expect one AI call per open job over the next cycles. Words alone (no definition change) only re-scan the JDs, without AI.

**The same category in YAML** (`interests.yaml`, under `signals.categories`):

```yaml
- id: ai_tools_budget
  kind: keyword
  label: { en: AI tools / token budget, zh: AI 工具 / token 预算 }
  icon: 🤖
  color: violet
  weight: 4
  high_value: false
  ai_confirm_only: false
  ai_definition: >-
    The employer pays for AI tools for the employee: a large or unlimited AI / LLM token or usage budget, company-paid
    licences or seats for AI assistants (GitHub Copilot, Cursor, Claude, ChatGPT, Gemini), or an explicit budget for AI
    tools. Not: building AI products, AI as a research topic, or "experience with AI tools" asked of the candidate.
  keywords: [unlimited tokens, AI budget, AI tools budget, Copilot license, KI-Budget, unbegrenzte Tokens]
  patterns:
    - '\b(?:unlimited|generous|large|uncapped)\s+(?:AI\s+|LLM\s+)?(?:token|usage|credits?)\b'
    - '\b(?:access|licen[cs]es?|seats?|subscriptions?)\s+(?:to|for)\s+(?:[\w-]+\s+){0,3}?(?:Copilot|Cursor|Claude|ChatGPT|Gemini)\b'
  exclude:
    - '\bexperience\s+(?:with|in|using)\s+(?:[\w-]+\s+){0,3}?(?:Copilot|Cursor|Claude|ChatGPT|Gemini)\b'
```

A broad word list catches more than you mean: turn on `ai_confirm_only` so a rule hit becomes a signal only when the AI
confirms it.

## Two-step extraction

1. Rules (every cycle, no AI cost): candidates are found in the JD using each category's word lists, and the sentence containing the hit is taken as the quote (at most `limits.quote_max_chars`, at most `limits.per_category_max` per category). Amounts are converted to annual salary using the `salary` section of `pipeline.yaml` (monthly × 12, etc.), and annual salaries below `amount.min_annual` are discarded. Hits of an `ai_confirm_only` category (T4 by default) are only candidates and become signals only when the AI confirms them.
2. AI (the `ai` step; `tasks.signals` can set its own provider order): for each job not yet reviewed (those with candidates first, at most `per_cycle_limit` per cycle, and jobs already hard-filtered are not sent), the AI confirms or rejects each candidate against the categories' `ai_definition`, adds phrasings the word list missed, and reads the amount's number and period. The **code** then checks again: the category must be a current amount / keyword category, the quote must be a substring of the JD (only whitespace differences are allowed, and what is stored is the JD's own text), the amount's number must appear in the quote, and the conversion is done by the code. Anything that fails is discarded.

When the JD or the word list changes it is re-scanned (only the signals of the active categories are replaced); a job already reviewed is not sent to the AI again as long as the JD and the prompt version are unchanged.

## A job's own salary → the amount category

A job's normalised salary (`jobs.salary_json`; source priority: the channel's structured field > the channel's salary text > a salary sentence in the JD body) produces an amount signal as soon as it is trustworthy (`qualityStatus = valid`, has a currency and a period, annual salary not below `amount.min_annual`; none without an amount category), whether or not the JD body has the same amount:

- When it comes from a channel field or the channel's salary text, the quote is that field's original text (for example LinkedIn's `€75,000.00/yr - €100,000.00/yr`), `signals.quote_source = structured`, and there is no JD offset; the detail page marks it "source field". When it comes from the JD body, the quote is the original sentence in the JD, `quote_source = description`.
- The bonus still looks only at "upper end of annual salary ≥ salary floor" (a range touching the floor also counts).
- An amount the rules found in the JD is merged away if it falls inside this salary's range or equals another amount; amounts that differ (such as OTE) are kept.
- When the salary changes (parsing improved, data source updated), the amount signal is updated accordingly, **without** re-scanning the JD or re-sending to the AI (`signal_scans.salary_hash` records the salary it is based on).

## How salary is read from text

The `salary` section of `pipeline.yaml`:

- Ranges with a unit on both ends can be read (`€75,000/yr - €100,000/yr`, `75k p.a. – 100k p.a.`, `EUR 75k–100k`).
- An amount in the JD body must: have a currency, have a salary word from `description_context_patterns` within `context_window_chars`, and no word from `negative_context_patterns` (relocation, allowance, learning budget, phone, vacation, funding ...) closer to the amount than the salary word (`negative_context_window_chars`). So "Relocation support: up to €2,500" and "€60/month phone allowance" do not become salary. Rule hits of the amount category get the same "benefit word closer" check.
- `plausible_per_period`: a stated amount (per period, not annualised) outside the range is flagged `AMOUNT_IMPLAUSIBLE_FOR_PERIOD` (needs review); a needs-review salary read from the JD body is not stored.
- When the parsing rules change (`SALARY_PARSER_VERSION`) or the `salary` section changes, the `pipeline` step re-reads the raw postings of all jobs with the current parser and corrects the stored salaries, once per change. Manually: `pnpm reprocess` (puts the original text back to pending and re-runs `pipeline` → salary → hard filter → rule signals → salary-signal sync → bonuses → German review, without collecting or spending AI; the option `--channel <id>` reprocesses only the original text of the given channel; use it on a copy of the database; see [extraction.md](extraction.md#reprocessing-jobs-already-in-the-database)).

## How to write the word lists

- `keywords`: literal words, whole-word, case-insensitive.
- `patterns`: regular expressions (`iu` flags), for inflections and combined phrasings (German word endings, "competitive … salary").
- `exclude`: if the start of a hit falls inside one of these matches (within the hit range, or within `limits.exclude_lookbehind_chars` characters before it), the hit is discarded; for example "diversity, equity and inclusion" is not equity, and the amount in "bonus of €25,000" is not salary.
- `amount.assume_currency` (amount category): when an amount has no currency and the same sentence has a salary word, this currency is assumed and the detail page says so; set it to `null` to discard such amounts.
- An amount in another currency keeps its original currency, and an annual salary in the market's base currency is also given using the reference rates in `pipeline.yaml: salary.fx_pivot` + `fx_rates` (currencies without a rate are not converted); the salary floor, the "minimum annual salary" filter, the stats page and the amount category's threshold all use this base-currency figure (see [market-packs.md](market-packs.md)).
- Hourly, daily and monthly pay are converted to annual using `salary.periods_per_year` (hour 2080, day 260, month 12); a single amount in the JD body "with a currency and an explicit hour/day/week/month period" ("Rate: 18 USD per hour") counts as salary even without a salary word, so it also goes through the salary floor.

## Pay that may be for another region

If the currency is not in `pipeline.yaml: salary.local_currencies` (default `[EUR]`), or the JD contains a phrasing from `salary.other_region_patterns` ("our US benefits", "rates vary per country", "pay range … in the US"), the salary and its amount signal are marked "may be pay for another region" (`salary_json.otherRegion`, and the amount signal's `value_json.otherRegion` = `currency` / `description`). It is still converted to an EUR annual salary and still goes through the salary floor; the list badge turns grey and says "may be non-local", the detail page states the reason and the EUR conversion, and Telegram adds "(may be pay for another region)" after the 💰.

Changing `fx_rates`, `local_currencies`, `other_region_patterns` or `other_region_weight` does **not** re-scan the JD or re-send to the AI: in the next cycle the `signals` step recomputes the stored amounts under the new settings (`revalueSignals`, once per change), and the bonuses are updated accordingly.

## Dashboard

- Job rows: one badge or tag per category (its colour and name; the amount category shows the amount).
- "Compensation and benefits" on the detail page: each signal's category, normalised value, bonus, original quote and source (rule / AI); the bonus total and the cap; the tags of the tag categories; the sentences quoted in the JD text and in the translation are highlighted in the category's colour.
- Detail page (v3): to the right of the title area are the rank value card (a 20-segment gauge + a stacked bar of match score / bonus, with the cap taken from `interests.yaml: bonus_cap`) and the annual salary card (a salary axis: the red line is `preferences.yaml: salary_floor_year`, the dashed line is the median of jobs with a stated salary this month (the /me floor preview and /insights use the same definition, each stating its scope and count; other-region and needs-review salaries do not go into the median), and below it "higher than X% of disclosed jobs"). When this month's sample is smaller than `ui.yaml: salary_stats.min_sample` (default 5), the median line and percentile are not drawn and the card says the sample is insufficient. "Compensation and benefits" has one row per signal, and the cap bar at the bottom stacks the categories, with the part beyond the cap drawn hatched; clicking a signal tag switches to the JD text, scrolls to the corresponding sentence and flashes it (only signals whose sentence really is in the JD have a jump; without one only the quote is shown). "Requirements check": the German A1–C2 ladder (you / required / gap; when the job says "not needed" or says nothing, only your level is drawn and the card says so, with no guessing), skill overlap (the skills in `me.yaml` against the job's skills, case-insensitive, with the aliases of `pipeline.yaml: skills` as synonyms, so if you write k8s it matches Kubernetes; an entry in the profile that lists several skills, such as "LLM / RAG" or "Kubernetes (k8s)", is split and each counts separately, and the list page uses the same rules), and the salary floor ✓ / ✕ (the stated upper end against the floor).
- Lists (Today, All jobs): the quick filter "High-value signals only" (URL parameter `high=true`; its tooltip names the current high-value categories).

## Command

```bash
# Run it over real jobs (use a database copy: it writes signals and scores)
DATABASE_URL=postgres://…/jobradar_copy pnpm smoke:signals --jobs 37,51,7
```
