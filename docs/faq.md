# FAQ

[English](faq.md) | [中文](faq.zh.md)

Short answers, with links to the full guides.

**Using it**

- [Does it apply to jobs for me?](#does-it-apply-to-jobs-for-me)
- [How does scoring work?](#how-does-scoring-work)
- [How do I add a company's career page?](#how-do-i-add-a-companys-career-page)
- [How do I change the language?](#how-do-i-change-the-language)
- [Can I use it on my phone?](#can-i-use-it-on-my-phone)

**Cost and AI**

- [What does it cost?](#what-does-it-cost)
- [Which AI do I need?](#which-ai-do-i-need)
- [Will it use up my Claude or ChatGPT plan?](#will-it-use-up-my-claude-or-chatgpt-plan)

**Privacy, sources, markets**

- [What leaves my machine?](#what-leaves-my-machine)
- [Which job sites does it read?](#which-job-sites-does-it-read)
- [Is scraping job sites allowed?](#is-scraping-job-sites-allowed)
- [I'm not in Germany. Does it work for me?](#im-not-in-germany-does-it-work-for-me)

**Running it**

- [Can several people share one installation?](#can-several-people-share-one-installation)
- [Does my computer have to stay on?](#does-my-computer-have-to-stay-on)
- [Does it run on Windows?](#does-it-run-on-windows)

## Does it apply to jobs for me?

No. Job Radar does not auto-apply, and it never fills in forms on job sites. It finds, reads, scores and keeps track;
you decide and you apply. When you want a tailored résumé, it exports the job ad and gives you a command for
resume-kit, a separate tool you run yourself ([resume-kit.md](resume-kit.md)).

## How does scoring work?

1. **Hard filters first.** Jobs outside your cities, below your salary floor, with a contract type you excluded or from
   a blocked company are filtered out without any AI call. They aren't deleted: you can still see them, with the reason.
2. **The AI scores the rest, 0–100.** It reads the job ad together with your profile summary, skills, languages, your
   job preferences and your own scoring criteria (priorities, nice-to-haves, dealbreakers). It returns the score, the
   reasons the job fits and the gaps. A job that hits one of your dealbreakers lands in the 0–29 band.
3. **Signals add a capped bonus.** Your signal categories (a stated salary, equity, benefits, anything you define) add
   points on top. Rank value = match score + the signal bonus, up to a cap (15 by default). Lists sort by rank value.
4. **Pushes use the rank value.** By default a job is pushed at 70 or more, or at 60 with a high-value signal.

When you change your scoring criteria, the current scores are marked stale and scored again over the next cycles. After a
profile change, Settings → Manual actions → "Re-score N stale scores" brings the old scores up to date.
Details: [signals.md](signals.md), [usage.md](usage.md), [telegram.md](telegram.md).

## How do I add a company's career page?

Job Radar reads company career pages hosted on Greenhouse, Lever, Ashby, Personio and SmartRecruiters.

- **In the browser:** Sources → registry (`/sources/registry`) → add a company: its name, the ATS, and its token (the
  company's id on that ATS, usually the last part of its careers page address). "Open board" checks you got it right.
- **In the file:** add an entry under `ats_boards` in `data/config/sources.yaml`.
- **Let it find boards:** with a Tavily key (free plan available), Job Radar searches for new boards about once a day
  and lists them on the Sources page for you to add or ignore ([tavily.md](tavily.md)).

The ATS channel itself has to be switched on. More: [sources.md](sources.md).

## How do I change the language?

- **Interface:** the language button in the top bar switches this browser between English and Chinese.
- **Everything else:** Settings → Interface → Languages (the file is `language.yaml`). There you set the default
  interface language, the language the AI writes in (any language code, such as `de` or `pt-BR`), the language job ads
  are translated into, and the language of Telegram messages and of the command-line tools.

Adding another interface language means adding a messages file. Details: [languages.md](languages.md).

## Can I use it on my phone?

Yes, two ways:

- **Telegram:** the jobs that clear your bar arrive as messages with buttons. Nothing on your machine needs to be
  reachable from the internet for this.
- **The dashboard:** it works at phone width. Open it over Tailscale (`tailscale serve --bg 3000`), which keeps it inside
  your own private network.

Don't forward port 3000 on your router or use a public tunnel: the dashboard has no login unless you set a password,
and anyone who reaches it can act as you. If other people share your tailnet, set one with `pnpm web:password`. Setup:
[installation.md](installation.md#8-optional-open-it-on-your-phone-tailscale).

## What does it cost?

Job Radar itself is free and open source (AGPL-3.0), and you run it on your own machine. What can cost money sits
outside it:

- **AI:** a `claude` or `codex` subscription you already have costs nothing extra per job. API keys are billed per
  token and stop at the monthly budget you set (`monthly_api_budget_usd` in `ai.yaml`).
- **Optional sources:** Bright Data and Apify (paid fallbacks for LinkedIn) bill your account; JSearch (Google Jobs) and
  Tavily (finding company boards) have free plans. Each paid or keyed source has a monthly budget.

Without any AI and with only the free sources, it costs nothing beyond your electricity. AI usage and cost are on
`/sources/ai-usage` ([ai-usage.md](ai-usage.md)).

## Which AI do I need?

None to start: without an AI, Job Radar still collects, de-duplicates, filters and shows jobs. Scoring, translation,
job breakdowns and the AI signal check start once you connect one of these:

| | How |
|---|---|
| Codex CLI (subscription) | `codex login` on the machine that runs the AI worker |
| Claude Code (subscription) | run `claude`, then `/login` |
| Anthropic, DeepSeek or MiMo (API) | the key in `.env`; DeepSeek and MiMo also need switching on in `ai.yaml` |

By default the worker tries codex, then claude, then the API providers. You can change the order, the model and the
effort per task on the AI tab of the Settings page. `pnpm ai:probe` shows what works right now.
More: [ai-providers.md](ai-providers.md).

## Will it use up my Claude or ChatGPT plan?

It's built not to. Each subscription CLI has a daily cap (claude 100 calls, codex 200 by default), and claude comes
after codex in the order because you probably use claude yourself too. When a provider reports a usage limit, every
process pauses it until the stated reset time. Each cycle also has a time budget for AI work (30 minutes by default);
what doesn't fit waits for the next cycle. All of it is adjustable in `ai.yaml` or on the Settings page
([ai-providers.md](ai-providers.md#usage-control-and-cooldown)).

## What leaves my machine?

Jobs, your profile and your applications stay in a database on your machine. There are no accounts, no telemetry and no
hosted service. What does go out:

- **To the AI you configured:** the job text, with your profile summary, skills, languages, job preferences (target
  roles, cities, salary floor, excluded companies and keywords, contract types) and your scoring criteria, for scoring.
  Only the job text for translation and breakdowns. Company, title, city, country and seniority when you click "Look up
  salary". The jobs you marked and their status, for the weekly suggestions (switch off with `suggest.enabled` in
  `schedule.yaml`).
- **To Telegram:** the push messages, to your own bot, if you set one up. They are stored on Telegram's servers.
- **To the sources you switched on:** requests for listings, and checks whether a posting is still online. Search APIs
  that need a key also see your search terms.

If a provider is unavailable the next one takes over, so every provider you leave switched on can receive the text; switch a provider off to keep text from that vendor ([which providers receive job text](ai-providers.md#which-providers-receive-job-text)).

With a subscription CLI, your provider's consumer terms apply, so check its data and training settings. The résumé
hand-off command, when you run it, sends your full résumé and the job ad to Claude.

Nothing in the database is deleted automatically yet: raw postings, emails and notifications stay until you remove the
database. The full list of what is stored, each AI provider's data policy and a checklist to remove everything:
[privacy.md](privacy.md).

## Which job sites does it read?

| Kind | Sources | Needs | In a new install |
|---|---|---|---|
| Job boards, official | Arbeitsagentur (German Federal Employment Agency), Arbeitnow (free public board API) | nothing | on (Germany pack) |
| Job boards, scraped | LinkedIn guest search, Indeed, StepStone, XING | nothing | off: the wizard shows the risk and asks first |
| Company career pages | Greenhouse, Lever, Ashby, Personio, SmartRecruiters | nothing; you add the companies | on |
| Search APIs | Google Jobs via JSearch | a RapidAPI key (free plan available) | off; switch it on once the key is in `.env` |
| Your inbox | Job-alert emails from a Gmail label | a Gmail app password | off; switch it on once the password is in `.env` |
| LinkedIn, more reliably | your own logged-in session (risky, see its guide), Bright Data, Apify | a one-time login, or a paid key | session off; Bright Data / Apify do nothing without a key |

You choose which ones run; one failing never stops the others. A source without its key shows "not configured" and
sends nothing. Every source and its states: [sources.md](sources.md).

## Is scraping job sites allowed?

It depends on the site and where you live, and this is not legal advice. Some sources read public pages or unofficial
endpoints, and some sites' terms of service forbid automated access. Using LinkedIn with your own logged-in session
breaks LinkedIn's user agreement and can get your account restricted.

What Job Radar does: it starts with every scraping source switched off and asks you to confirm the risk before you
turn one on, it throttles requests, never tries to get past a login wall, CAPTCHA or verification page, and
stops using a source that keeps failing. What you do: read the terms of every site you switch on, keep volumes low,
prefer official APIs and your own alert emails, and don't republish what it collects. You are responsible for how you
use it.

## I'm not in Germany. Does it work for me?

Yes. The defaults assume no country, and you pick your market in the setup wizard. A market pack holds what's specific
to a country: its cities and regions, the local-language rules, the base currency and its job boards. Job Radar ships a
neutral pack (`generic`) and a Germany / EU pack (`de`). For another country, copy a pack into `data/config/packs/` and
adjust it ([market-packs.md](market-packs.md)). The company career pages, LinkedIn, Indeed and Google Jobs work in many
countries; StepStone, XING, Arbeitsagentur and Arbeitnow are the Germany pack's own boards.

Salary reading knows the euro, dollar and pound plus many more currencies (among them CAD, AUD, SGD, JPY, CNY, INR,
BRL and ZAR), with rough exchange rates you can adjust; the market form tells you when your currency has no rate. In a
country Indeed doesn't cover, only Indeed is skipped and the other sources keep working. Check the salary figures on a
few jobs if you're outside Europe.

## Can several people share one installation?

No. Job Radar is one person, one installation: one profile, one set of preferences, one Telegram chat. Two people means
two installations, each with its own database. There are no user accounts inside the app, and none are planned.

Two installations fit on one machine: clone a second checkout and, before its first start, give it its own compose
project name, database volume and ports in its `.env` (`COMPOSE_PROJECT_NAME`, `JOBRADAR_PG_VOLUME`,
`JOB_RADAR_WEB_PORT`, `DB_HOST_PORT`). Each also needs its own Telegram bot. Step by step:
[multiple-instances.md](multiple-instances.md).

## Does my computer have to stay on?

For cycles to run on schedule, yes: Job Radar runs on your machine, not in a cloud. If it was off at a scheduled time,
the runner catches up once when it starts again, and takes a missed backup too. To run a Mac unattended (log in after a
reboot, start Docker at login, power on after a power cut, no sleep), follow [host-setup.md](host-setup.md). Pushes
need the AI worker to be running as well.

## Does it run on Windows?

Yes, inside WSL2. Clone the repository into the Linux file system (for example `~/job-radar`, not under `/mnt/c`,
where bind mounts are slow and permissions differ), switch on Docker Desktop's WSL integration for that distribution,
and install Node, pnpm and the `claude` / `codex` CLIs inside WSL. Then follow the Linux steps; the AI worker runs in WSL
too, and the dashboard opens at <http://127.0.0.1:3000> in the Windows browser. Notes:
[platform notes](installation.md#macos-linux-windows). Job Radar is run day to day on macOS and Linux, so an issue
about anything that behaves differently on WSL is welcome.

---

Not answered here? Ask in [Discussions](https://github.com/Joevonlong/job-radar/discussions), or browse all guides in
[docs/](README.md).
