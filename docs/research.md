# Company background

[English](research.md) | [中文](research.zh.md)

A job page can show what is publicly known about the company behind a posting: what it does, its industry and size, when it
was founded, where it is based, its funding, products, working language, what employee review sites say, and recent news.
An AI provider finds this with web search when you press a button. It is **off by default**.

Everything in the panel is an AI web search result, and the panel says so ("AI web search · unverified"). Job Radar has not
checked whether a source is right. Read the source before you rely on a field. No score, filter, push or other AI task uses
these results: they are only displayed.

## Turning it on

Settings → Research → "Enable company background", or `enabled: true` in `data/config/research.yaml`. The job page then shows
a "Look up company" button in the "Company background" panel. Nothing is looked up until you press it.

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

## How far the limits go

- **`claude-cli`:** page fetches are pre-approved only for the sites in `company.allowed_domains` and your confirmed domain, and
  every other tool call is denied. This is the CLI's own permission check, not a network boundary. Its web search is **not** limited
  to those sites.
- **Anthropic API:** search results and fetches are limited to those sites by the API, and `max_searches` is enforced by the API.
- **`codex-cli`:** not in the default order, because its web search has no domain limit at all. If you add it to the task
  yourself, the panel warns about this.
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

The form covers the switch, `ttl_days`, `max_per_day`, `max_searches` and `timeout_seconds`. These are edited in the file (Settings →
Advanced):

| Key | What it does |
|---|---|
| `company.allowed_domains` | The sites whose pages may be opened, besides your confirmed domain. No private or local names, no public suffixes. |
| `company.non_company_hosts` | Hosts never taken as a company's own website (job boards, social networks). |
| `company.max_field_chars` | Longest stored text of one field. |
| `company.employees`, `company.rating` | The plausible range of those values. |
| `company.web_search_usd` | Cost of one search for the usage statistics. |

## Before rolling back

The migration only adds a table and three columns of `companies`; older code ignores them. Older code also ignores `research.yaml`.
Older code refuses `ai.yaml` if a form save wrote `tasks.company_research` into it: delete that key (and
`reasoning_effort_by_task.company_research` if present) before you switch.

## If something goes wrong

| The panel says | What to do |
|---|---|
| No provider can search the web | Set `claude-cli` or the Anthropic API for the task on the AI tab |
| Login or key rejected | Fix the login of the CLI, or the key in `.env` |
| Daily limit reached | Wait, or raise `company.max_per_day` |
| Nothing passed the checks | Nothing was stored. Try again later; a name that fits several companies often gives no answer |
| `research.yaml` cannot be read | `pnpm config:check` says why |
