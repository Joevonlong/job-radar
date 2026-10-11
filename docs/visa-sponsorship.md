# Visa sponsorship

[English](visa-sponsorship.md) | [中文](visa-sponsorship.zh.md)

Job Radar reads what each job description says about visa sponsorship or a work permit and shows it with the posting's own
words. It runs on rules only (no AI call, no tokens) and never changes a score, a rank or a notification.

## What "visa sponsorship" means in a German posting

Germany has no register of sponsoring employers like the UK. A non-EU candidate usually applies for the EU Blue Card or a
work visa themselves; the employer provides the contract and sometimes helps with the process or the move. So a German
posting that "offers visa sponsorship" usually means help with the paperwork or relocation, and a posting that says
nothing does not mean the employer refuses. The most useful thing the check finds is therefore the opposite signal: a
posting that refuses sponsorship, or that asks for a work permit you must **already** have.

## The four results

| Result | What the posting says | Example |
| --- | --- | --- |
| `offered` | It mentions support with a visa, a Blue Card, a work permit or relocation | "We offer visa sponsorship and relocation support" |
| `not_offered` | It refuses sponsorship (`no_sponsorship`), or requires a permit you already hold (`permit_required`) | "We are unable to offer visa sponsorship"; "You must hold a valid work permit for Germany" |
| `unclear` | It mentions visas but the rules cannot tell, or it says both | "Questions about visas and relocation? Ask us"; "…or are eligible for an EU Blue Card" |
| `not_mentioned` | Nothing about visas | — |

The pages say "mentions visa or relocation support", never "sponsors": a mention is not a promise. Every result except
`not_mentioned` keeps up to three quotes, each a verbatim piece of the job description with its position.

## Where you see it

Whether the list shows it depends on **About me → I need visa sponsorship from the employer** (`me.yaml: needs_visa_sponsorship`) and on
`ui.yaml: job_checks.visa.badges`:

| `badges` | Needs sponsorship | Not needed |
| --- | --- | --- |
| `auto` (default) | badge and filter | neither |
| `always` | badge and filter | badge and filter |
| `never` | neither | neither |

- **List badge**: green "Visa support" for `offered`; a dashed red outline "No visa sponsorship" or "Work permit
  required" for `not_offered`. `unclear` and `not_mentioned` have no badge.
- **Filter** on /jobs, in the chips, in saved views and in the phone's filter drawer: **Support mentioned** (`visa=offered`)
  shows only `offered` jobs; **Not refused** (`visa=not_denied`) shows every job except `not_offered` ones. Jobs
  not checked yet and `unclear` jobs stay in it: a job that might work is better seen than hidden.
- **While the filter is hidden** (the check is off, `never`, or `auto` and you do not need sponsorship) a `visa=` in the
  URL or a saved view is **ignored but kept**: it filters nothing, has no chip, is not counted, and "Clear" leaves it. The
  saved view still has it, and it applies again once the filter is back.
- **Job page**: the checks card has a "Visa sponsorship" line whenever the check is on, with the result, the quotes and
  **View in the original**, which jumps to the passage (dashed underline) in the job description. It is coloured (red for
  `not_offered`, green for `offered`) only for a user who needs sponsorship; otherwise it is grey.

`needs_visa_sponsorship` stays on your machine: it is read only to decide what the pages show and is never sent to an AI
or any other service.

## How a posting is read

The description is cut into pieces: sentences, list items, and a short heading line joined with the line after it. A
heading is a line of at most `heading_max_chars` characters that ends in ":", starts with "#" (markdown), or is a single
phrase without end punctuation: "Visa sponsorship:" / "Not available", "## Visa sponsorship" / "Not available for this
role.". A heading followed by a list stays on its own, and so does a heading followed by another heading; the items of a
list keep the line that introduces it (a heading, or any line ending in ":") as their context. Each piece is judged on its
own:

1. A piece about something else is skipped: payment cards ("Visa/Mastercard"), "sponsored events", "Sponsoring von
   Veranstaltungen", and the employer's own product or customers ("We help our customers with visa applications", "You
   will support our immigration team", "Wir unterstützen Unternehmen bei der Relocation").
2. An "offered" phrase with a negation word ("not", "no", "none", "unable", "without", "nicht", "nein", "kein…", "leider", …) is
   `unclear`, never `offered`. The negation counts inside the phrase, within `negation_words_before` words before it
   ("We do not offer relocation support"), and within `negation_words_after` words after it until the clause ends
   ("Relocation support is not available", "Relocation support: No", "Relocation-Support bieten wir nicht an"). A clause
   ends at ";", a dash, "but", "however", "aber", "jedoch" and the like, so "We offer visa sponsorship, but no signing
   bonus" is still `offered`. A negation word in the line that introduces a list counts for every item of the list: "What
   we can't offer:" / "- Visa sponsorship" is `unclear`, "What we offer:" / "- Visa sponsorship" is `offered`.
3. A bare noun in a list ("- Visa sponsorship", "- Visa-Unterstützung") counts as `offered` only as a list item of its
   own, never as a heading.
4. A "permit required" phrase next to an alternative ("…or are eligible for an EU Blue Card", "bei Bedarf unterstützen
   wir") is `unclear`, not a refusal.
5. A refusal and an offer in the same piece are `unclear`.
6. A visa word together with a context word ("visa" + "relocation", "Visum" + "unterstützen") with nothing clearer is an
   unclear mention. The bare word "Visa" alone never counts.
7. A heading about visas whose next line has a negation word ("Visa sponsorship" / "We can't help with this.") is
   `unclear` unless it is a refusal, and so is a list under a negated heading (rule 2).

The job's result: `offered` and `not_offered` pieces together make it `unclear` (both quoted); otherwise `not_offered`;
otherwise `offered`, unless a heading of rule 7 says no, which makes it `unclear`; otherwise `unclear`; otherwise
`not_mentioned`. For a company whose name is a visa word (Visa Inc.) only the
phrases that combine the word with its context count.

Text hidden from readers that the AI trap detection found ([ai-traps.md](ai-traps.md)) does not count.

English patterns come with every market; German patterns with the German market. The patterns live in the market packs
([market-packs.md](market-packs.md#visa-patterns)).

## When it runs

The cycle's `signals` step runs the check after the AI trap scan. A job is checked again only when its description, its
company, its hidden text or the patterns changed; at most `pipeline.yaml: job_checks.visa.per_cycle_limit` jobs per cycle
(never-checked jobs first, newest first). A failure makes the step "partial" and is retried next cycle.

For jobs collected before the update, or after you changed the patterns:

```bash
pnpm visa:scan                  # preview: what would change, nothing is written
pnpm visa:scan --write          # store the results (a second run reports 0 changes)
pnpm visa:scan --job 1234       # one job, checked again even when it is current
pnpm visa:scan --limit 500 --json
pnpm visa:scan --text jd.txt    # try the rules on a text file, no database needed
```

## Settings

`ui.yaml` (yours):

```yaml
job_checks:
  visa:
    enabled: true   # false: nothing is checked and no page shows it
    badges: auto    # auto | always | never (the list badge and the /jobs filter)
```

`pipeline.yaml` (shipped), see [configuration.md](configuration.md#visa-check-pipelineyaml--uiyaml):

| Key | Default | What it does |
| --- | --- | --- |
| `job_checks.visa.per_cycle_limit` | 2000 | jobs checked per cycle at most |
| `job_checks.visa.max_quotes` | 3 | quotes kept per job (at most 10) |
| `job_checks.visa.quote_max_chars` | 280 | longest quote; a longer sentence is cut around the phrase |
| `job_checks.visa.negation_words_before` | 6 | words before an "offered" phrase searched for a negation |
| `job_checks.visa.negation_words_after` | 5 | words after it, within its clause, searched for a negation |
| `job_checks.visa.heading_max_chars` | 60 | longest line that counts as a heading and is read with the next line |

## As a deal-breaker

To hide jobs that refuse sponsorship, add a visa rule on **My profile → What I want → Deal-breakers** (**Add visa rule**)
([deal-breakers.md](deal-breakers.md#visa-not-offered)):

```yaml
deal_breakers:
  - id: visa
    label: No visa sponsorship
    type: visa_not_offered
```

It vetoes only `not_offered` jobs (both kinds); `unclear` and `not_mentioned` jobs pass. It does nothing while
`needs_visa_sponsorship` is false, and `pnpm config:check` warns about that.

The filter runs before the `signals` step, so the rule reads the description on the spot with the same patterns but
**including** hidden text: a new job has no trap scan yet, and reading the last one would make the same job flip between
cycles. In the rare case of a refusal hidden in white text, the rule vetoes the job while the job page says
`not_mentioned`.

## What it does not do

- It does not decide which visa you need or whether you qualify (Blue Card salary thresholds and the like), and it reads
  no immigration law or sponsor register.
- It never changes a score, a rank, the AI scoring input or a Telegram message.
- It only reads English and German; postings in other languages get `not_mentioned` unless they use English phrases.

## Before rolling back to an older version

Older versions refuse a `ui.yaml` with `job_checks.visa` and a `preferences.yaml` with a `visa_not_offered` rule. Before
you roll back, delete `job_checks.visa` from `ui.yaml` (or the whole `job_checks` block if it has nothing else you
changed) and any `visa_not_offered` rule from `deal_breakers`. The `job_visa` table can stay: older versions do not read
it.
