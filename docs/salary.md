# The salary panel: level and lookup

[English](salary.md) | [中文](salary.zh.md)

A job page has one salary panel, "Salary · what this job pays", under "Pay and benefits". It answers "what does this job
pay?" from every source it has, and says how far each can be trusted:

- **Level** (always on, no AI): where the job's stated salary stands among the salaries of comparable postings you
  collected, and what the company's other postings state.
- **Lookup** (off by default, uses AI and web search): on request, the AI searches public web pages for the company's pay
  level and the band of this role, and shows its sources.

Both are configured in `salary.yaml` (Settings → Salary, or the Advanced tab).

## Reading the panel

**Three figures on top**

| Cell | What it shows |
|---|---|
| Stated in the JD | The salary range the posting states (a fact), highlighted. Under it, how far it is above or below the median of similar postings. Only the posting's own figure is compared; AI figures never are. A salary that needs review, or one in another currency or region, is not compared or drawn: the cell says so, or shows the posting's wording. |
| Similar postings | The median of the benchmark group (see below) and where this job stands in it. |
| This company · AI estimate | The role's band from the salary lookup, marked "unverified", with the company's overall level under it. Without a lookup (or when it cannot run) the cell says why. A lookup that found company-wide figures but no band for this role shows "No range found for this role"; the company's overall median is then labelled "Company-wide median" and is never shown as this role's number. |

**One scale for every source.** Below the cells, four rows sit on one shared salary scale (it narrows to the figures drawn,
within `ui.yaml` `salary_axis`; a value outside it is cut at the end and marked `«` or `»`):

1. **This posting**: the range the JD states (yellow block; grey when its upper end is below your salary floor).
2. **Similar postings**: the group's P10 to P90 as a block, its median as a dashed line.
3. **Same company, other postings**: one dot for each other posting of the company that states a salary (equal figures
   are one dot with a count, like `×2`). The median is marked only with at least `benchmark.min_sample` postings.
4. **This company · this role (AI)**: only the role's band from the lookup, as a dashed, hatched block with the AI's
   median. A band in total pay (bonus or equity included) is dotted instead of hatched and says it cannot be compared
   with a base salary. A band in a currency without an exchange rate is written in its own currency and not drawn.

Each row says where its figures come from and how far to trust them ("JD text · fact", "AI web search · unverified"). A
row without figures stays and says what is missing. The red line is your salary floor, also written out in words.

**Footer.** On the left, where the AI figures come from (sites, provider, time, and what was sent); on the right the lookup
button, the daily count, and "Look it up yourself" links to salary sites. The annual salary card at the top of the page
links here ("See all sources"). Its median is the median of this month's stated salaries; the panel's median is that of
similar postings. They are different groups and may differ.

## Salary level: the benchmark

After every cycle, the `pipeline` step rebuilds the benchmark from the postings in your database:

1. Each posting with a stated salary is converted to a year in the market's base currency (the same normalized figure the
   annual salary card shows). Only postings first seen in the last `benchmark.window_days` days count.
2. Its **role family** comes from the title: the first family in `role_families` whose pattern matches wins (`LLM
   Engineer` → ML / AI engineer). A title that matches no family is not part of the benchmark.
3. Postings are grouped by family × seniority × place, and each group with at least `benchmark.min_sample` salaries keeps
   its percentiles (P10, P25, median, P75, P90).

The job page picks the narrowest group that exists, from "same family, same seniority, same city" through "same
country", "any seniority" to "family only", and says which one it used and how many salaries it holds. A job with a
salary gets its position ("P72: above the median"), a job without one still sees the range of its group. A group built
from a handful of postings is a rough hint: the sample size is always shown.

The benchmark uses only salaries the postings state. AI lookups never count in it or in any filter, including the
salary floor. The panel shows only "sample n", with no JD / lookup split.

With `benchmark.enabled: true`, `pnpm salary:benchmark` rebuilds the benchmark right away and prints it (`--json` for
the raw groups). It does not recompute while the benchmark is off.

### Links to salary sites

`deep_links` lists search pages the panel links to ("Look it up yourself"), filled in with the job's company, title or city: Levels.fyi,
Glassdoor and Kununu by default. They open in your browser; Job Radar never fetches these sites. The sites block
automated clients, so the URL formats were checked by hand; if a site changes its URLs, fix the template in `salary.yaml`.

| Placeholder | Becomes |
|---|---|
| `{company}` | Company name |
| `{company_slug}` | Company name in lower case, words joined by `-` |
| `{title}` | Job title |
| `{city}` | City |
| `{country}` | ISO country code |

## Salary lookup (AI with web search)

Turn it on with `lookup.enabled: true` (Settings → Salary → "Enable salary lookup"). The panel then shows a
"Look up salary" button. Nothing is looked up unless you click it.

What happens on a click:

1. The web app queues a `salary_lookup` request; the ai-worker (or the runner in container mode) takes it.
2. The AI is given only the **company name, job title, city, country and seniority**: never your profile, never the
   job description. It searches the web, reads salary pages, and answers with the company's pay level, the band of this
   role, related roles at the company, a confidence, and the source of every figure.
3. Job Radar checks the answer's format and plausible range before storing it: every figure needs a source link (https)
   from the answer; figures outside `lookup.sanity_annual` are dropped; amounts are converted to the base currency (a currency without an
   exchange rate is shown in its own currency, and figures above `lookup.unconvertible_max_annual` are dropped); sources
   on hosts outside `lookup.allowed_fetch_domains` are marked "not on your salary-site list". This does not verify the
   sources or figures, including those on listed hosts. The panel says how many items were dropped.
4. The result is stored and shown for `lookup.ttl_days` days to every job of the same company, role family, seniority
   and place without asking again. "Look up again" asks anyway.

When an ATS board's company name is corrected, cached lookups follow the renamed company or move to the merged company
with their cache keys. Their sources, provider and original expiry stay intact; a name correction does not require another lookup.

Limits:

- `lookup.max_per_day`: lookups per 24 hours (every request counts, a failed one too; a cached answer does not). Once they are used up, the button on the job page is disabled until earlier lookups pass 24 hours.
- `lookup.timeout_seconds`: one lookup, all providers and retries together.
- `lookup.max_searches`: web searches per lookup. The Anthropic API enforces it; the CLIs are asked to keep to it.
- `lookup.web_search_usd`: the fee per web search of the Anthropic API, counted in AI usage and the monthly API budget.
- `lookup.allowed_fetch_domains`: each entry must name one site. Public suffixes such as `co.uk`, `com.au` or
  `github.io` are refused, since they would allow every site under them. With an empty list the Anthropic API does not
  search at all.

Which AI runs it is the task `salary_lookup` in `ai.yaml` (Settings → AI → task overrides). Only providers that can
search the web are tried:

| Provider | How it searches | Domain limit |
|---|---|---|
| `claude-cli` (default, first) | WebSearch and WebFetch tools, pre-approved for the domains in `allowed_fetch_domains`; needs `claude` 2.1.296 or newer | Pages are fetched only from the listed hosts; search itself is not limited |
| `anthropic` (default, second) | The API's server-side web search tool | Search results only from the listed domains |
| `codex-cli` (only if you add it) | Codex's built-in web search | None: the settings page warns about it |

DeepSeek and MiMo cannot search the web and are skipped for this task. If no web-capable provider is available, the
panel says so and links to the AI settings.

Every other AI task still runs without any tools; see [ai-providers.md](ai-providers.md) and [SECURITY.md](../SECURITY.md).

### Reading the result

- **AI lookup**: the badge identifies a result from AI web search.
- **AI estimate (unverified)**: marks the company pay level, this role's band and every related-role band. Job Radar
  has not checked these figures or sources.
- **AI's own confidence**: the model's assessment of its answer, not a confidence rating from Job Radar.
- **Pay at this company**: below / around / above the market, or top of the market, with a typical salary; an AI estimate.
- **This role**: the band (P10 to P90 style range and median, base or total pay) and, when it is base pay in the base
  currency, its position in your benchmark group.
- **Related roles at this company**: other bands the AI gave.
- **Sources given by the AI (unverified)**: numbered links supplied by the AI; every figure refers to them.
  "not on your salary-site list" means a host outside `lookup.allowed_fetch_domains`. Being on the list does not mean
  the page was opened or its figures checked.

The estimate uses the company, role type, seniority and place; similar postings share this lookup. It is not based on
this job description. When it was made on another posting, the panel says "This lookup was made on another posting:"
with that posting's title and a link. If that posting was deleted, it says "The posting this lookup was made on has
been deleted."

These estimates are only displayed: they are not facts of the job and never enter the salary benchmark or any filter.
Check the sources before you rely on them.

A stored result stays on the page after the lookup is turned off or its AI becomes unavailable; the panel then says why it
cannot be run again, with a link to the setting.

## salary.yaml at a glance

```yaml
benchmark:
  enabled: true          # rebuild after each cycle
  window_days: 365       # only postings first seen in this window
  min_sample: 5          # smaller groups are not kept
role_families:           # first match wins; regular expressions, case-insensitive
  - id: ml_engineer
    label: { en: ML / AI engineer, zh: 机器学习 / AI 工程师 }
    patterns: ['\b(?:machine learning|ml|ai|llm)\s+(?:engineer|developer)\b']
deep_links:
  - { id: levels_fyi, label: Levels.fyi, url: 'https://www.levels.fyi/companies/{company_slug}/salaries' }
lookup:
  enabled: false
  ttl_days: 30
  max_per_day: 10
  timeout_seconds: 300
  max_searches: 8
  allowed_fetch_domains: [levels.fyi, glassdoor.com, glassdoor.de, kununu.com]
  sanity_annual: { min: 5000, max: 2000000 }
  unconvertible_max_annual: 100000000000
  web_search_usd: 0.01
```

The old `benchmark.include_ai_lookups` setting was removed by the salary config migration (1 → 2); see
[configuration.md](configuration.md#salary-salaryyaml) for automatic and manual upgrades.

Add the words of your market's language to the family patterns (the shipped file includes German ones). The deep link
URLs can be edited on the Settings page too: they are only links your browser opens, and no request of Job Radar goes to
them. They must be `https://` or `http://` URLs.

## Troubleshooting

| The panel says | What to do |
|---|---|
| "This title matches no role family" | Add a pattern for it to `role_families` |
| "Too few postings of this kind state a salary" | Fewer than `min_sample` salaries in every group: wait for more postings, or lower `min_sample` |
| "The old salary comparison contained AI figures and is hidden" | Turn the salary benchmark on (`benchmark.enabled: true`) and wait for the next cycle, or turn it on and run `pnpm salary:benchmark`. Running the command while it is off does not recompute it. |
| "None of the AI providers set for this lookup can search the web" | Put `claude-cli` or `anthropic` in `tasks.salary_lookup.order` and make sure it is available (`pnpm ai:probe`) |
| `auth` / `rate_limited` / `timeout` | The provider's own problem; the request is not retried automatically |
| "The ai-worker has not answered" | The ai-worker is not running or busy: see `/sources` |
| "The salary tables do not exist yet" | Run the database migrations (`pnpm db:migrate`, done by the deploy) |
