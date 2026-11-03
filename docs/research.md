# Company background

[English](research.md) | [中文](research.zh.md)

A job page can show what is publicly known about the company behind a posting: what it does, its industry and size, when it
was founded, where it is based, its funding, products, working language, what employee review sites say, and recent news.
An AI provider finds this with web search when you press a button. It is **off by default**.

Everything in the panel is an AI web search result, and the panel says so ("AI web search · unverified"). Job Radar has not
checked whether a source is right. Read the source before you rely on a field. No score, filter, push or other AI task uses
these results: they are only displayed.

## Turning it on

Settings → Research → "Enable research", or `enabled: true` in `data/config/research.yaml`. The job page then shows
a research bar under the title and a "Look up company" button in the "Company background" panel. With the shipped `research.yaml`
research then also starts by itself when you save a job ([automatic research](#automatic-research)); an older file you kept stays
manual until you choose otherwise.

Which AI runs it is the task "Company background" on the AI tab. The default order is `claude-cli`, then the Anthropic API.
Only providers that can search the web are used. If none of them is available the panel says so instead of showing the button.

## What leaves your machine

| Sent | When |
|---|---|
| The company name, cleaned of markup and control characters | Every lookup |
| The website domain of the company, **only if you confirmed it yourself** | Every lookup of that company |

Never sent: the job title, the location, the description, your profile, or a domain Job Radar inferred from postings. Anyone can
write any link into a posting, so such a domain never goes into the request or into the list of pages the AI may open.

These go to the provider of the task, which then searches the web. The sites it reads see requests from that provider, not from
you.

## The research bar

Under the job's title, one line says where the company lookup, the JD breakdown and the salary lookup of this job stand: how old the
result is, in progress, paused by the usage cap (with the time it comes back), failed, off (with a link to the setting), or not run
yet. Each has a button of its own that runs it again; "Research all" runs whatever has no current result. These count as manual:
they use the manual limits and go ahead of anything automatic, and pressing one also moves a waiting automatic request of the same
kind up. With research off the bar only lists stored results, without buttons, and without any result there is no bar.

## The company list

On `/companies` a company with a stored result shows its summary and size in one line. "Details" opens the same fields with their
sources, read only and marked as unverified, a button that looks it up again (one manual lookup, through the company's newest job),
and the website to confirm or change. Opening the list sends nothing: a company without a result stays without one, and there is no
button for all of them.

## Automatic research

With `enabled: true` and `auto.trigger`:

| `auto.trigger` | Research starts when |
|---|---|
| `manual` | never by itself |
| `favorite` (shipped) | you star a job, on the web or in Telegram |
| `favorite_or_applying` | also when its status becomes interested, preparing or applied |

`auto.items` says which parts run (`company`, `breakdown`, `salary`). The salary part also needs `lookup.enabled` in `salary.yaml`, the
breakdown part needs `enabled` in `breakdown.yaml`; a part that is off is left out.

**What this sends:** the company lookup sends what is listed above. An automatic salary lookup sends the company name, job title,
city, country and seniority ([salary lookup](salary.md#salary-lookup-ai-with-web-search)). A breakdown sends the JD to the provider of
that task, as it always does. **The timing of these requests reflects what you save and apply to**, which a pressed button did not
reveal in the same way. If that matters to you, keep `auto.trigger: manual`.

**Limits:** `auto.max_per_day` runs per 24 hours for saved and applied jobs, counted per job and separate from the manual limits. A
run that finds everything cached does not count, and one job counts at most once per 24 hours whatever triggered it. Past the limit
nothing is queued and the activity log says so.

**The usage cap:** if the provider cooldown, the usage cap or the API budget would stop a web lookup right now, it is not queued at
all and the bar lets you start it later; a breakdown is still queued. The checks read the shared state only, so a star never starts a
provider or moves a window.

**Undo:** removing the star or undoing a status does not cancel what is already queued. It only stops anything further.

**Turning it off:** `auto.trigger: manual` stops new runs. `enabled: false` also makes the ai-worker stop automatic requests still in
the queue; requests you started yourself are not affected for the salary lookup and the breakdown.

### High-score new jobs

`auto.high_score` is off by default. When on, the late AI step of each cycle queues research for new jobs first seen within
`max_age_days`, with a rank value of at least `min_rank`, that are open and neither starred nor researched before: at most
`per_cycle_limit` per cycle and `high_score.max_per_day` per 24 hours, counted apart from saved jobs. This sends the same as above for
jobs you have not looked at yet, so it uses more of your quota.

## The company's website

The panel asks you about the company's website, because a confirmed domain helps the search find the right company:

- **A suggestion to confirm.** Job Radar takes the domain most of the company's job links point at (`careers.example.de` becomes
  `example.de`), skipping job boards and applicant tracking hosts (`company.non_company_hosts`). The suggestion is stored and shown,
  and nothing else happens: until you press "Confirm" it is not sent and its pages are not opened.
- **Your own.** "Change" or "Add website" takes a domain or a pasted address. The server reduces it to its domain and refuses
  addresses, local names, public suffixes and job boards.

A domain you gave is never replaced by a suggestion.

## How far the limits go

- **`claude-cli`:** page fetches are pre-approved only for the sites in `company.allowed_domains` and your confirmed domain, and
  every other tool call is denied. This is the CLI's own permission check, not a network boundary. Its web search is **not** limited
  to those sites.
- **Anthropic API:** search results and fetches are limited to those sites by the API, and `max_searches` is enforced by the API.
- **`codex-cli`:** not in the default order, because its web search has no domain limit at all. If you add it to the task
  yourself, the panel and the AI settings tab warn about this.
- A site list entry that is a private address, a local name or a public suffix is refused when the file is loaded.

## Checks before anything is stored

The answer is untrusted: the AI read web pages. Each field stands alone. A field is dropped, and counted in the panel, when:

- its source is not a public `https` link (no address, no local or reserved name, no credentials, no other port);
- its text or source link contains invisible characters;
- its text or source link holds text written at an AI (the instruction patterns of `traps.yaml`, whether or not the trap scan of
  postings is switched on);
- its value cannot be right: employees or a rating outside `company.employees` / `company.rating`, a founding year in the future,
  a news date in the future or not a date.

What is left is plain text, limited to `company.max_field_chars`, and is shown as plain text with its source as a link. If nothing
is left, nothing is stored and the panel says the lookup found nothing usable. If `traps.yaml` cannot be read, the lookup fails
rather than store an unchecked answer.

## The result

One result belongs to the company, so every job of the company shows it. It stays current for `company.ttl_days`. After that the
panel still shows it and says it may be out of date. "Look up again" always searches again. Confirming a different website makes a
stored result no longer current: the panel says so. When two companies are merged, the results move to the kept company.

The result stays in the database (table `company_research`) after you turn the feature off, and the panel keeps showing it, without
a button. Deleting the database removes it.

## Limits and cost

- `company.max_per_day`: requests in the last 24 hours. Every request counts, failed ones too. An answer from the stored result does not.
- `company.max_searches`: searches of one lookup. The Anthropic API enforces it, the CLIs are asked to keep to it.
- `company.timeout_seconds`: the whole lookup, all providers and retries together.
- A lookup uses tokens, and with the Anthropic API a fee per search (`company.web_search_usd` is what the usage page counts). See
  [ai-usage.md](ai-usage.md).

## `research.yaml`

The form covers the switch, `ttl_days`, `max_per_day`, `max_searches`, `timeout_seconds` and the `auto` block. The other keys are edited in the file;
`company.allowed_domains` and `company.non_company_hosts` decide which hosts this machine may fetch, so the web app (Advanced editor
included) refuses to change them and they only change by hand:

| Key | What it does |
|---|---|
| `company.allowed_domains` | The sites whose pages may be opened, besides your confirmed domain. No private or local names, no public suffixes. |
| `company.non_company_hosts` | Hosts never taken as a company's own website (job boards, social networks). |
| `company.max_field_chars` | Longest stored text of one field. |
| `company.employees`, `company.rating` | The plausible range of those values. |
| `company.web_search_usd` | Cost of one search for the usage statistics. |
| `auto` | [Automatic research](#automatic-research). A `research.yaml` without this block behaves as `trigger: manual`. |

## Before rolling back

The migration only adds a table and three columns of `companies`; older code ignores them. Older code also ignores `research.yaml`.
Older code refuses `ai.yaml` if a form save wrote `tasks.company_research` into it: delete that key (and
`reasoning_effort_by_task.company_research` if present) before you switch.

Automatic requests carry a marker older code does not accept. Before going back to a version without the research bar, set
`enabled: false` and wait until the queue has no `origin: auto` request left; a request left over fails as an invalid request and
nothing else happens. A version from before this feature refuses the `auto` block of `research.yaml`: remove the block too. The
`research_auto_runs` table stays and older code ignores it.

## If something goes wrong

| The panel says | What to do |
|---|---|
| No provider can search the web | Set `claude-cli` or the Anthropic API for the task on the AI tab |
| Login or key rejected | Fix the login of the CLI, or the key in `.env` |
| Daily limit reached | Wait, or raise `company.max_per_day` |
| Nothing passed the checks | Nothing was stored. Try again later; a name that fits several companies often gives no answer |
| `research.yaml` cannot be read | `pnpm config:check` says why |
