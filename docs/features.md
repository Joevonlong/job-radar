# Features and screenshots

[English](features.md) | [中文](features.zh.md)

## What it is

Job Radar is a job feed you run on your own computer.

You tell it what you're after: the roles, the cities, the pay you won't go below, the things you'd never accept. On the
schedule you pick, it pulls new postings from the job boards and company career pages you choose, merges the
duplicates, clears out the noise, and has your AI read every job that's left. Each job gets a 0–100 match score with the
reasons it fits and the gaps. The ones that clear your bar land in Telegram, with buttons to act on them. Everything
else waits on a dashboard in your browser.

**Job Radar does not auto-apply.** It finds, reads, scores and keeps track. You decide, and you apply.

It's self-hosted and open source. Your database is stored on your machine, it uses the AI subscription you already pay for (or
an API key), and there are no accounts and no telemetry.

## Why Job Radar

### 1. Every source, one feed

Pick the job boards and company career pages you care about. They all land in one list. The same job posted on five
sites shows up once, with every link kept. Agency posts and closed ads are flagged. Text hidden in an ad to steer AI
readers is stripped before your AI sees it.

- LinkedIn, Indeed, StepStone, XING, Arbeitsagentur, Arbeitnow, Google Jobs
- Career pages on Greenhouse, Lever, Ashby, Personio and SmartRecruiters
- Your own job-alert emails from Gmail

Sources that scrape a site (LinkedIn guest search, Indeed, StepStone, XING, Google Jobs via the sidecar) start switched off. The setup wizard shows
the terms-of-service risk and asks you to confirm before you turn one on.

<p align="center"><img alt="Three copies of one job from different sites merge into a single entry" src="images/demo/one-feed.webp" width="800"></p>

### 2. Your rules, not ours

This is the part that makes it yours. Set the pay you won't go below, your cities, contract types and companies to
skip. Then say what matters in plain words, in any language: what you want most, what's a nice extra, and what you
will never accept. A job that hits a dealbreaker drops into the 0–29 band and sinks to the bottom.

- Salary floor, cities, contract types, blocked companies
- Scoring criteria in your own words
- Your own signal categories (equity, bonus, benefits, anything) and saved views

<p align="center"><img alt="Adding a dealbreaker in the scoring settings, then the job's score drops after a re-score" src="images/demo/your-rules.webp" width="800"></p>

### 3. It reads every job, so you don't have to

Every job that passes your filters gets a 0–100 match score with reasons and gaps. Pay buried in the text is found,
quoted, turned into a yearly figure you can compare, and set against what similar jobs you collected pay. Long ads can
be broken down into tasks, stack and must-haves, matched against your skills, and translated into your language.

- Match score with reasons and gaps
- Salary found, quoted, made yearly, compared with similar jobs
- Job breakdown, skill match, translation

<p align="center"><img alt="Salaries written in different ways line up on one yearly salary axis, with the quote from the ad" src="images/demo/salary.webp" width="800"></p>

### 4. The good ones come to you

Connect your own Telegram bot, and after every cycle the jobs over your bar arrive with their score, pay and badges.
Tap **👍 Interested** or **🚫 Ignore** right there (and **📄 Tailor résumé** if you use resume-kit), and your application
board follows. A reminder nudges you when an application goes quiet.

- Push with buttons, quiet hours
- Application board and reminders
- Alerts when a source breaks

<p align="center"><img alt="A Telegram push on a phone; tapping Interested moves the card on the application board" src="images/demo/telegram.webp" width="800"></p>

**Underneath:** self-hosted · open source (AGPL-3.0) · your database is stored on your machine · your AI subscription or API
key · no accounts · no telemetry.

## Screenshots

<table>
  <tr>
    <td width="50%"><img alt="Today" src="https://joevonlong.github.io/job-radar-site/readme/V-02.webp"><p align="center"><b>Today</b></p></td>
    <td width="50%"><img alt="Job breakdown & skill match" src="images/demo/breakdown.webp"><p align="center"><b>Job breakdown & skill match</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Clean input for your AI" src="https://joevonlong.github.io/job-radar-site/readme/V-06.webp"><p align="center"><b>Clean input for your AI</b></p></td>
    <td width="50%"><img alt="Filters and saved views" src="https://joevonlong.github.io/job-radar-site/readme/V-10.webp"><p align="center"><b>Filters and saved views</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Track applications" src="https://joevonlong.github.io/job-radar-site/readme/V-13.webp"><p align="center"><b>Track applications</b></p></td>
    <td width="50%"><img alt="Keyboard flow" src="https://joevonlong.github.io/job-radar-site/readme/V-11.webp"><p align="center"><b>Keyboard flow</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Many sources" src="https://joevonlong.github.io/job-radar-site/readme/V-16.webp"><p align="center"><b>Many sources</b></p></td>
    <td width="50%"><img alt="Your AI, your subscription" src="https://joevonlong.github.io/job-radar-site/readme/V-17.webp"><p align="center"><b>Your AI, your subscription</b></p></td>
  </tr>
</table>

### Static screenshots

<p align="center"><img alt="Demo: Today, a job, its salary sentence, Mark applied, the board" src="images/job-radar-demo.gif" width="960"></p>

<table>
  <tr>
    <td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="images/today-dark.png"><img alt="Today: the new jobs of this cycle" src="images/today-light.png"></picture><p align="center"><b>Today</b></p></td>
    <td width="50%"><picture><source media="(prefers-color-scheme: dark)" srcset="images/job-detail-dark.png"><img alt="A job: score, quoted salary and an AI trap" src="images/job-detail-light.png"></picture><p align="center"><b>A job: score, quoted salary, AI trap</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Application board" src="images/pipeline.png"><p align="center"><b>Application board</b></p></td>
    <td width="50%"><img alt="Settings: search keywords from an example setup" src="images/settings.png"><p align="center"><b>Settings</b></p></td>
  </tr>
  <tr>
    <td width="50%"><img alt="Telegram message format preview" src="images/telegram.png"><p align="center"><b>Telegram message (format preview)</b></p></td>
    <td width="50%"><p align="center"><img alt="Today on a phone" src="images/mobile-today.png" width="260"></p><p align="center"><b>On a phone</b></p></td>
  </tr>
</table>

Demo data throughout: the companies and jobs are invented. To click around the same sample data yourself, see
[Try it with sample data](development.md#try-it-with-sample-data).

## All features

**One place**

| | |
|---|---|
| Many sources | LinkedIn (guest search; optional: your own logged-in session (experimental, not yet tested against a real login), or paid Bright Data / Apify / Monid), Indeed, StepStone, XING, Arbeitsagentur, Arbeitnow, Google Jobs via JSearch, company career pages on Greenhouse, Lever, Ashby, Personio and SmartRecruiters, job-alert emails from Gmail. [All sources](sources.md) |
| Your consent first | Sources that scrape a site or use your own LinkedIn login are off in a new install. Turning one on shows the risk and asks you to confirm. [Scraping](sources.md#scraping) |
| Isolated | One source failing never stops a cycle. Each has a circuit breaker and an optional monthly budget. |
| One job, not five | Near-duplicates across sources merge into one entry, with every source link kept. |
| Noise flagged | Agency posts are marked. A job that has not been seen for about a week is marked "possibly closed" (a time-based hint); the link check then decides: when every link is dead it marks the job "closed", and a live link reopens it. An active job no source has returned for about two weeks also gets its links checked, even without that mark. After 30 days possibly closed, unprotected jobs become dormant and leave default lists and automatic work; a source listing them again wakes them. |
| Seen again | Source-observed relists have a dated tag, a scope-aware quick filter and a Today note; they do not refresh freshness or trigger AI work or pushes. |
| Closed jobs and archive | Mark a job closed (undo any time); Current / Archive / All keeps closed and dormant jobs accessible, with reason filters and last-listed sorting. Jobs and their postings, scores, translations and analyses are never automatically deleted. |
| Clean input for your AI | Some ads hide text meant to steer AI readers (white-on-white text, invisible characters, "if you are an AI…"). Job Radar strips it before any AI reads the ad and shows you what it found. [How](ai-traps.md) |

**Tuned to you**

| | |
|---|---|
| Hard filters | Cities, salary floor, contract types, blocked companies. Filtered jobs aren't deleted; you can see them and why. |
| Visa sponsorship | If you need sponsorship, each job shows what its ad says about a visa or work permit, quoted from the ad: support mentioned, refused, or a permit you must already hold. Filter on it, or veto refusals. [How](visa-sponsorship.md) |
| Ghost jobs | Optional: a "Likely ghost" or "Watch" mark for postings open for months, relisted under a new id, written as a talent pool, or with a thin description, each reason shown. Filter on it, or dismiss it per job. Only a hint: the score stays. [How](ghost-jobs.md) |
| Scoring criteria | Your priorities, nice-to-haves and dealbreakers, one sentence each, any language. A dealbreaker puts a job into the 0–29 band. |
| Signal categories | Up to 12 of your own (an amount, keywords or a tag), each with a weight and colour. Start from a blank category or a ready-made preset such as "AI tools / token budget" or "Open-source time". Badges show up in lists and pushes. [Signals](signals.md) |
| Filters and saved views | Score, signal, source, city, remote, language requirement, salary, status, date. Save a combination and switch to it on Today. |
| Sort and catch up | Click a column header on Jobs to sort by score, salary or freshness. Jobs you haven't opened yet are bold with a dot; show "Unseen only", "Mark all as seen", and a divider marks what's new since your last visit. |
| Market packs | A neutral default plus a Germany / EU pack (local job boards, German-level rules, EUR). For another country, copy a pack. [Market packs](market-packs.md) |
| Watched companies | New jobs from companies you watch skip the push threshold, even before they have a score, and their on-site and hybrid jobs are kept in any city of your country. |

**AI reads for you**

| | |
|---|---|
| Match score | 0–100, with the reasons it fits and the gaps, based on your profile, your preferences and your criteria. |
| Salary, surfaced | Rules find it, the AI confirms it, every amount is quoted from the ad. Monthly, hourly, "up to 120k" and foreign currencies become a yearly figure in your currency, original kept, shown on an axis against your floor. |
| Salary level | Where a job's stated pay stands among comparable postings you collected (same kind of role, seniority and place), with the sample size shown, plus links to salary sites. No AI involved. [Salary](salary.md) |
| Salary lookup | Optional, off by default (`lookup.enabled: true` in `salary.yaml`), one click per job: the AI searches public salary pages for the company's pay level and the band of this role, and shows its sources. It only sends company, title, city, country and seniority. [Salary](salary.md#salary-lookup-ai-with-web-search) |
| Ranking | Rank value = match score + a capped bonus for signals like a stated salary or equity. |
| Facts from the ad | Remote / hybrid / on-site, contract type, local-language requirement (such as German B2). |
| Job breakdown | Optional, off until you switch it on. Tasks, stack, experience, soft skills and languages, each marked required or nice-to-have with a quote from the ad. Your skills are matched locally; your profile isn't sent for this. [Breakdown](breakdown.md) |
| Application writer | Optional, off until you switch it on. Drafts answers to application questions and cover letters from the material you tick, marks the evidence behind each sentence, and sends nothing until you press Write. [Application writer](application-writer.md) |
| Translation | Long ads in your language, original one tap away. High scorers are translated automatically. |
| Weekly suggestions | From the jobs you marked, the AI suggests new signal words, companies to watch and filters, each with evidence. Nothing changes until you approve. |
| Insights | New jobs per day, sources, cities, how often pay is disclosed, signals, filter reasons. |

**On your phone**

| | |
|---|---|
| Push after every cycle | Off until you connect your own Telegram bot. Then a summary, then one card per qualifying job: rank value, badges, title, company, city. At most 10 per cycle by default. [Telegram](telegram.md) |
| Buttons | 👍 Interested · 🚫 Ignore · ⭐ Save, plus 📄 Tailor résumé when resume-kit is set up. The board updates as you tap. |
| Quiet hours and reminders | Pushes wait out the night. A daily reminder lists jobs you liked but haven't applied to, and applications with no reply. |
| Health alerts | A source's circuit breaker opened, a login expired, a budget hit 80 %, every AI provider failed. |
| No open port | Telegram button taps are fetched by long polling. Nothing on your machine faces the internet. |
| Application board | Drag cards from New to Offer; every move is on a timeline and can be undone. Favorites are kept separately, even for closed jobs. |
| Résumé hand-off | Exports the ad and gives you the command for resume-kit, a separate résumé tailoring tool. [resume-kit](resume-kit.md) |

**Run it yourself**

| | |
|---|---|
| Setup wizard | Eight short steps in the browser (or in the terminal): language, market, profile, targets, sources, AI, Telegram, a first cycle. |
| Your AI | Your `claude` or `codex` subscription login (nothing billed per token), an API key with a monthly budget, or both. |
| Ops built in | Daily backups of the database, your config and your profile, with retention; a safety backup before every database migration; restore tooling; `pnpm run doctor` health check; a deploy script that upgrades to a release tag. |
| Optional password | No login needed on your own machine. Before anyone else can reach the dashboard, set a password with `pnpm web:password`. [Web access](configuration.md#web-access-optional-password-bind-address-and-port) |
| Light, dark, phone | Paper-light and terminal-dark themes, English and Chinese interface, a full phone layout, keyboard shortcuts (`⌘K`, `j` / `k`, `s`, `x`, `f`). |
| Works with your AI tools | Plain YAML config with comments, command-line tools (`pnpm run doctor`, `pnpm sources:list`, `pnpm config:check`), and job ads exported as Markdown for other tools. |

## How it works

```mermaid
flowchart LR
  you["Browser / phone"] --> web
  subgraph compose["docker compose"]
    web["web (Next.js)<br/>127.0.0.1:3000 by default"]
    runner["runner<br/>schedule, collect, process,<br/>backup, Telegram callbacks"]
    jobspy["jobspy<br/>Python sidecar"]
    db[("db (Postgres 17)")]
  end
  worker["ai-worker (host process)<br/>scoring, signals, translation, push"]
  cli["claude / codex CLI<br/>or AI API"]
  tg["Telegram"]
  boards["job boards, ATS, APIs"]

  web <--> db
  runner <--> db
  worker <--> db
  runner --> jobspy
  runner --> boards
  jobspy --> boards
  worker --> cli
  worker --> tg
```

1. **Collect.** On your schedule, the runner fetches new postings from the sources you switched on and stores each one as it arrived.
2. **Clean.** Pay, remote mode, languages and contract type are read out, duplicates merge, your hard filters apply.
3. **Score.** The ai-worker on your computer hands each job to your AI: `claude` or `codex` with your own login, or an API key.
4. **Push.** Jobs over your bar go to Telegram, if you set it up. Everything is on the dashboard.

| Part | Where it runs | What it does |
|---|---|---|
| `web` | container, `127.0.0.1:3000` by default (`JOB_RADAR_WEB_BIND`, `JOB_RADAR_WEB_PORT`) | The dashboard. Settings pages write your config files; buttons queue requests. |
| `runner` | container | Runs the cycles (collect, process, filter, signals, maintenance), the daily backup and Telegram button taps. |
| `jobspy` | container, internal network only | Scraping sidecar for LinkedIn guest search, Indeed and Google Jobs. |
| `db` | container | All data, in the Docker volume `jobradar-pg` (by default). |
| `ai-worker` | **your machine (host)** | Picks up every AI request, runs it with your CLI login or API key, writes the result back, sends the Telegram push. |

The containers hold no AI credentials. No AI connected yet? Job Radar still collects, de-duplicates, filters and shows
postings; only scoring, translation, breakdowns, the AI signal check and the push wait for one.
