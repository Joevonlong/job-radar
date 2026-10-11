# Deal-breakers

[English](deal-breakers.md) | [中文](deal-breakers.zh.md)

A deal-breaker is a rule you write that vetoes a job before any AI call: "the posting requires German above my level",
"the posting says 100% on-site". The rules live in `preferences.yaml` under `deal_breakers` and are edited on **My
profile → What I want → Deal-breakers**, or by hand in `data/profile/preferences.yaml`.

They run in the hard filter, next to the salary floor and the blacklist. A vetoed job costs no AI call, because only jobs
that pass the hard filter are scored.

## What happens to a vetoed job

- The job is **not deleted**. It is hidden from the lists like any other filtered job, and **Show filtered** shows it with
  the reason "Deal-breaker: <name>". Deal-breaker reasons are listed first.
- The job page says which rule vetoed it and quotes the posting's own sentence the rule matched. For a language gate it
  also shows both levels ("The rules read: C1; your level: B1"), so you can see when the rules misread the posting.
- **Keep anyway** on the job page keeps the job: it is scored from then on, and the reason stays on record. The choice is
  per job, not per rule.
- A job scored before you added the rule keeps its score: the list still shows it under **Show filtered**. Changing only
  the deal-breakers does not mark any score stale. The next filter run applies the new rules to every open job in
  place, and removing a rule brings its jobs back without re-scoring them.
- Vetoed jobs are not scored and not sent to Telegram.

## Writing rules

Each rule has an `id` (lower case letters, digits, `-` and `_`; it is what each vetoed job records), a `label` (the name
shown in the lists, at most 60 characters), `enabled` (default `true`) and a `type`. There are three types.

### Language gate

```yaml
deal_breakers:
  - id: language-gate
    label: German above my level
    type: language_gate
```

The gate reads the level of the market's local language that the posting **requires**: the CEFR level the pipeline's
own rules read from the text when the job was collected. It never uses the AI's reading, so a job gets the same result
before and after it is scored.

- Without `at_least` the threshold is your own level in **About me** (`me.yaml: languages`): a required level above
  yours vetoes. When About me lists no level for that language, any stated level vetoes.
- With `at_least: C1` the threshold is fixed: a required level of C1 or above vetoes, and About me is not read.
- "Preferred", "not required" and "not stated" never veto: what a posting does not say never removes it.
- The gate covers only the market's local language (German for the DE market). A market without a local-language step
  has nothing to read: the rule does nothing, and `pnpm config:check` warns about it.

When you change your level in About me, the next filter run updates every open job.

### Phrase

```yaml
deal_breakers:
  - id: onsite-only
    label: 100% on-site
    type: phrase
    patterns: ['100\s?%\s*(?:on-?site|vor Ort)']
    scope: description
  - id: rust
    label: Rust jobs
    type: phrase
    terms: [Rust]
    scope: title
```

- `terms`: whole words or phrases. Case and accents are ignored (`Munchen` matches `München`, `ss` matches `ß`), and a
  term matches only as a whole word: `Rust` does not match "trust".
- `patterns`: regular expressions, case ignored. `\b` (word boundary) only knows the letters a-z, digits and `_`:
  `\bÜberstunden` does not match "bezahlte Überstunden". For whole words, prefer `terms`, which know every letter.
- `scope`: `title`, `description` or `any` (default).
- `unless`: regular expressions; a hit inside a sentence that matches one of them does not count.

```yaml
  - id: travel
    label: Lots of travel
    type: phrase
    terms: [travel]
    unless: ['\bno travel\b', 'travel (?:is )?not required']
```

This vetoes "Frequent travel to clients" but not "No travel required".

Business travel over 50% has no type of its own yet. This pattern comes close in German and English postings:

```yaml
  - id: travel-over-50
    label: Travel over 50%
    type: phrase
    patterns:
      - 'Reisetätigkeit.{0,30}(?:[5-9]\d|100)\s?%'
      - 'travel.{0,30}(?:[5-9]\d|100)\s?%'
```

It matches "Reisetätigkeit von bis zu 60 %" and "travel up to 75%", but not "Reisetätigkeit ca. 20 %" or "travel 10% of
the time".

### Visa not offered

```yaml
deal_breakers:
  - id: visa
    label: No visa sponsorship
    type: visa_not_offered
```

**Add visa rule** on the card. It vetoes a job whose description refuses visa sponsorship ("We are unable to offer visa
sponsorship") or asks for a work permit you must already have ("You must hold a valid work permit for Germany"): the
`not_offered` result of the [visa check](visa-sponsorship.md). A posting that is unclear, offers both, offers an
alternative ("…or are eligible for an EU Blue Card") or says nothing passes.

- It only works while **About me** says you need sponsorship (`me.yaml: needs_visa_sponsorship: true`); otherwise it
  does nothing, and the card and `pnpm config:check` say so (`visa_not_needed`).
- It uses the patterns of the market packs, not your own; the rule has no other keys. It reads the description on the
  spot, hidden text included (the filter runs before the trap scan), so in rare cases the job page's visa line says
  "not mentioned" for a job the rule vetoed. See [visa-sponsorship.md](visa-sponsorship.md#as-a-deal-breaker).
- The job page quotes the refusing sentence and says which kind it is.
- It runs under the same time limits as your phrase rules (`rule_budget_ms` per filter run, `match_ms` for the job
  page's explanation, see [Limits](#limits)): a market pack edited by hand cannot hold up the filter step either.

### Limits

Your patterns run on every open job in every filter run, and JavaScript regular expressions have no time limit of their
own, so the time a pattern may take is limited in three places:

- **When you save.** Shapes that backtrack badly are refused, with the reason: a repetition inside a repetition (`(a+)+`,
  `(\w*)*`); two or more open-ended runs of broad characters (`.*x.*y`, `\d+.*\d+`, `\w+\s*\w+`; bound them instead,
  as in `.{0,40}`); a pattern that starts with an open-ended `.*` (leave it out: a pattern matches anywhere already); a
  repeated group whose alternatives can start alike (`(a|ab)+`). Each pattern is also tried on a few long test texts (a
  line as long as `match_text_max_chars` without a match), and one that takes longer than `match_ms` on any of them is
  refused as well. `pnpm config:check` runs the same checks on a file you edited by hand.
- **When the filter runs.** A rule with a pattern that is too slow on the test texts is left out. Each rule may take
  `rule_budget_ms` in one filter run; a rule that uses it up is stopped for the rest of that run. A job such a rule did not
  judge keeps the veto it had from the rule before, so a busy machine never lets a vetoed job through. Both cases show as
  `too_slow` in the filter step's result (`dealBreakerWarnings`), the step counts as partial on the runs view, and the
  runner log names the rule.
- **On the pages.** The card's preview stops after `preview_ms` and then says how many jobs it counted; the job page gives
  up explaining a veto after `match_ms`.

`pipeline.yaml: filter.deal_breakers` sets these limits:

| Key | Default | What it limits |
| --- | --- | --- |
| `max_rules` | 20 | rules that count (at most 50) |
| `max_pattern_chars` | 200 | length of one term or pattern (at most 500) |
| `match_text_max_chars` | 20,000 | characters of a description that are searched |
| `rule_warn_ms` | 200 | `pnpm deal-breakers:check` warns about a rule slower than this over all open jobs |
| `match_ms` | 100 | one pattern on one test text, and the explanation on a job page |
| `rule_budget_ms` | 2,000 | one rule over all jobs in one filter run or one preview |
| `preview_ms` | 3,000 | the whole preview on the card |

Saving refuses rules over `max_rules` and `max_pattern_chars`.

## Checking rules

Each rule on the card shows how many of the open jobs in the database it would veto, with three examples. The same count
comes from the command line:

```bash
pnpm deal-breakers:check              # every rule: count, time, examples
pnpm deal-breakers:check --id travel  # one rule
pnpm deal-breakers:check --limit 50 --json
```

It writes nothing. For each rule it prints the time it took over all open jobs and warns when that is over
`pipeline.yaml: filter.deal_breakers.rule_warn_ms` (default 200 ms): a slow pattern slows every filter run.

## What a rule cannot say

A condition that needs judgement ("a company culture I would not like") cannot be a rule. Put it in **Settings → AI →
scoring criteria** under "unacceptable": the AI reads it when it scores a job and puts such a job in the 0-29 band (see
[settings.md](settings.md#ai-tab-scoring-criteria)). That still costs one scoring call per job.

## Before rolling back to an older version

Versions before deal-breakers do not know the `deal_breakers` key and refuse a `preferences.yaml` that has it. **Delete
the `deal_breakers` key before you roll back.** Nothing else needs undoing: there is no database change, and the reasons
already stored on vetoed jobs are shown as they are.

Versions before the visa rule refuse a `deal_breakers` list with a `visa_not_offered` rule: delete that rule (or the whole
key) before rolling back to one of them.
