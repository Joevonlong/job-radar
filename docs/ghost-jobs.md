# Ghost jobs

[English](ghost-jobs.md) | [中文](ghost-jobs.zh.md)

A "ghost job" is a posting with no real opening behind it: a talent pool, a job kept online for months, or one relisted
under a new id again and again. Job Radar can mark postings that show such signs. It runs on rules only (no AI call, no
tokens), it is **only a hint**: it never changes a score, a rank, a filter result or a notification, and a mark does not
mean the job is not real.

The check is **off by default**. Preview it first (`pnpm ghost:check --json`, below: it reads every open job and writes
nothing), then turn it on in `ui.yaml` when the share of marked jobs looks right for your market.

## The signals

Each signal adds points; the points come from `pipeline.yaml: job_checks.ghost` (defaults below).

| Signal | When it counts | Points |
| --- | --- | --- |
| `long_open` | An open job whose source gives a trusted posted date (company ATS, LinkedIn with your login) has been online for at least 90 days (1) or 180 days (2). Without a trusted date the days count from when Job Radar first saw it, at most 1 point. | 1–2 |
| `repost_label` | The source itself labels the posting "Reposted" (LinkedIn with your login) | 1 |
| `reposted` | The same source listed the job again under a new id, at the same place, at least 30 days after the earlier one. Only sources whose ids stay the same for one posting (company ATS, LinkedIn with your login, StepStone, XING, Arbeitsagentur) count; never two different sources. | 2 |
| `evergreen_wording` | The job description says it is a talent pool or always open ("This posting is for our talent pool", "We are always hiring", "Wir stellen laufend ein", "Initiativbewerbung (m/w/d)", "Es gibt keine konkrete Stelle"). Not "We're always looking for people who …" (the About-us text of many real postings) | 2 |
| `thin_description` | The description comes from a source that keeps the full text and has fewer than 120 words, or no duties section (a heading such as "Responsibilities", "Your tasks", "What will I be doing?", "The impact you'll have", "Deine Aufgaben", "Darum geht's"; read without emoji or arrows around it, with "&amp;" as "&" and a final "…" as ":"; a line ending in "..." or in a "?" after a question word is a heading only right above a list, with at most one lead-in line between that ends in ":" or looks like a heading, so "Which tasks can our AI automate?" in the company text is none). When the job has a current [JD breakdown](breakdown.md), its duties list decides instead of the headings, an empty one included. With `thin_description.infer_from_headings: false` the headings are not read: without a current breakdown only a short description counts. | 1 |

The sum gives the level:

| Level | Points | Shown as |
| --- | --- | --- |
| `none` | below 3 | nothing |
| `watch` | 3 or more | a grey "Watch" |
| `likely` | 5 or more, **and** at least one of `repost_label`, `reposted`, `evergreen_wording` | an orange, hatched "Likely ghost" |

Time and length alone never make a job `likely`: an old job with a short description stays `watch`. A company on your
`trusted_companies` list is never marked.

## How the wording is read

The description is cut into pieces (sentences, list items, a short heading with the line after it), as for the
[visa check](visa-sponsorship.md#how-a-posting-is-read). A piece with an evergreen phrase does **not** count when:

- a negation word is inside the phrase, within `negation_words_before` words before it, after it in the same clause
  (within `negation_words_after` words; to the end of the clause for German, which puts "nicht" last), or in the heading of
  its list ("This is not a talent pool posting", "Für unseren Talentpool ist diese Anzeige ganz ausdrücklich nicht
  gedacht"). A comma before "not", or before a German relative clause or conjunction ("…, die keine Angst vor neuen
  Technologien haben"), ends the clause; "not only" and "nicht nur" are not negations;
- the piece is itself a question ("Always hiring? Acme automates your sourcing");
- it is about the employer's product, customers or a team of that name ("We build talent pool software", "Our ATS lets
  hiring managers add candidates to the talent pipeline", "Evergreen job listings are a core feature of our ATS", "Join our
  Talent Network team", "Wir helfen Unternehmen beim Aufbau ihres Talentpools", "Unsere Software hilft Personalabteilungen
  beim Aufbau eines Talentpools");
- it is a duty of the role ("You will build our talent pipeline", "You will source candidates for our upcoming roles", "You
  will screen applicants for our engineering talent pool", "Identify and attract candidates for our talent pool", a list item under "Your tasks:" or "What will I be doing?"), while
  "We are building a talent pool", "We are hiring for our AI talent pool" and "Help us grow by joining our talent pool" count;
- it is training for later roles or an event for a community ("Mentoring for our future roles", "Weiterbildung für
  zukünftige Positionen", "Organize events for our engineering talent community", "Join our AI talent community meetups");
- a phrase that needs recruiting words around it has none: "join our AI talent pool" counts with "apply", "candidates",
  "future opportunities" or the like in the same sentence ("By joining our AI talent pool, you will be contacted … for our
  future opportunities"; not "networking opportunities"), "access to the largest tech talent pool in Europe" never does;
- it says the role is a real opening after all ("…, but this role is a concrete opening", "this role is based in Berlin");
- it is the footer of a real posting ("Don't see a role that fits? Join our talent community", "Not ready to apply? Join our
  talent community to stay in touch", "Keine passende Stelle dabei? Dann bewirb dich initiativ"; the question right before
  the sentence counts too, see `lead_in_question` in [market-packs.md](market-packs.md#ghost-job-patterns)), a conditional
  ("If there is no open role…"), a privacy note, or "we may also consider you for future roles".

The quote is a verbatim piece of the description with its position. Text hidden from readers that the
[AI trap detection](ai-traps.md) found does not count. The phrases live in the market packs
([market-packs.md](market-packs.md#ghost-job-patterns)); English comes with every market, German with the German market.

## Where you see it

Only while `ui.yaml: job_checks.ghost.enabled` is `true`:

- **List** (/jobs, Today, Favorites): the mark under the score. Its tooltip names the three strongest reasons and says
  that the score is not affected.
- **Filter** on /jobs, in the chips and in saved views: **All** (no filter), **Suspected only** (`ghost=only`: `watch` and
  `likely` jobs) and **Hide likely** (`ghost=hide`: every job except `likely` ones; jobs not checked yet stay). Dismissed
  jobs count as unmarked. While the check is off, a `ghost=` in the URL or a saved view is ignored but kept, like the visa
  filter.
- **Job page**: the mark on the score card (a link to the checks card) and the line **Is the job real?** on the checks card,
  after the AI trap line and before the visa line. It lists every reason, quotes the evergreen sentence with **View in the
  original** (a wavy underline in the description), and has **Not a ghost job**.

The pipeline board shows no mark.

## Not a ghost job

**Not a ghost job** on the job page dismisses the mark: it disappears from the list, the score card, the description's
wavy underline and the "Suspected only" filter. The dismissal keeps the kinds of reasons the job had; if a new kind comes up later (say, a
relisting), the mark comes back. **Undo** takes the dismissal back. Nothing else changes.

## When it runs

The cycle's `signals` step runs the check after the AI trap and visa checks. A job is checked again only when something
it is made from changed (its description, status, sources, AI breakdown, hidden text, the patterns, the settings or a
source's declarations), or when it reaches the next `long_open` tier; at most
`pipeline.yaml: job_checks.ghost.per_cycle_limit` jobs per cycle (never-checked jobs first, newest first). A failure makes
the step "partial" and is retried next cycle.

```bash
pnpm ghost:check                 # preview: what every open job would get, nothing is written (works while the check is off)
pnpm ghost:check --json          # the same as JSON, with the share of each level
pnpm ghost:check --write         # store the results (only while the check is on; at most per_cycle_limit jobs; a second run reports 0 changes)
pnpm ghost:check --job 1234      # one job, checked again even when it is current
pnpm ghost:check --limit 500     # at most 500 jobs (newest first), for a preview or a write
```

## Settings

`ui.yaml` (yours):

```yaml
job_checks:
  ghost:
    enabled: false             # true: the cycle checks jobs and the pages show the marks
    trusted_companies: []      # company names never marked, e.g. ["Acme GmbH"]; their marks disappear at once
```

`pipeline.yaml` (shipped), see [configuration.md](configuration.md#ghost-job-check-pipelineyaml--uiyaml):

| Key | Default | What it does |
| --- | --- | --- |
| `job_checks.ghost.per_cycle_limit` | 2000 | jobs checked per cycle at most |
| `job_checks.ghost.levels` | `{ watch: 3, likely: 5 }` | points for each level |
| `job_checks.ghost.long_open.tiers` | 90 days → 1, 180 days → 2 | days open and their points |
| `job_checks.ghost.long_open.first_seen_max_points` | 1 | most points without a trusted posted date |
| `job_checks.ghost.repost_label.points` | 1 | |
| `job_checks.ghost.reposted.min_gap_days`, `.points` | 30, 2 | |
| `job_checks.ghost.evergreen_wording.points` | 2 | |
| `job_checks.ghost.thin_description.min_words`, `.points` | 120, 1 | |
| `job_checks.ghost.thin_description.infer_from_headings` | `true` | without a current JD breakdown, the duties headings decide whether a long description has duties; `false`: they are not read, and only a short description counts |
| `job_checks.ghost.quote_max_chars` | 280 | longest quote |
| `job_checks.ghost.negation_words_before` / `_after` | 6 / 5 | words searched for a negation around an evergreen phrase |
| `job_checks.ghost.heading_max_chars` | 60 | longest line read as a heading with the next line |

Every signal has `enabled` too; `points: 0` turns one off as well.

## What it does not do

- It does not know whether a job is real: a big company keeps some postings open for months on purpose, and a short
  description can be honest. Read the reasons, not only the mark.
- It never changes a score, a rank, the AI scoring input, a filter result or a Telegram message.
- It reads English and German wording only.

## Before rolling back to an older version

Older versions refuse a `ui.yaml` with `job_checks.ghost` and a market pack whose `rules.yaml` has a `ghost` section.
Before you roll back, delete `job_checks.ghost` from `ui.yaml` and the `ghost` section from your own packs. The `job_ghost`
table can stay: older versions do not read it.
