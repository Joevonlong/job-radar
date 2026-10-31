# Documentation

[English](README.md) | [中文](README.zh.md)

File names such as `ai.yaml` or `data/config/ai.yaml` mean your own copy in `data/config/`; the shipped defaults in
`config/` are read-only (see [configuration.md](configuration.md)). Most settings can also be changed on the Settings
page, or in its Advanced tab.

Start with `docker compose up -d --build` and the setup wizard at `/setup` (see [setup.md](setup.md)). After the wizard, the
[tuning guide](getting-started.html) (open it in a browser) explains the pages and how to adjust what you get, with annotated
mock-ups.

| Guide | What it covers |
|---|---|
| [features.md](features.md) | **What it does**: the four ideas behind it, every feature, how the parts fit together, screenshots and clips |
| [installation.md](installation.md) | **Install from scratch**: requirements, every step on macOS, Linux and Windows (WSL2), the AI worker as a service, Telegram, phone access, updating, backups, uninstalling, troubleshooting |
| [faq.md](faq.md) | Short answers: cost, AI options, privacy, sources, markets, phone access, Windows |
| [setup.md](setup.md) | **First start**: the setup wizard (`/setup`) and `pnpm run setup`, the answers file, `setup.yaml`, reopening the wizard |
| [usage.md](usage.md) | **Start here for daily use**: opening the dashboard, health checks (doctor, Sources page, alerts, logs), the pages, reading a job description, querying jobs from a terminal |
| [configuration.md](configuration.md) | Where configuration lives: shipped defaults `config/` and your own `data/config/`, which one is read, `pnpm config:init / migrate / check`, `config_version` upgrades |
| [market-packs.md](market-packs.md) | The market you search in: choosing it, what follows it (places, remote scope, local language, base currency, channels), pack files, writing a pack, `pnpm market:show` / `market:regress` |
| [languages.md](languages.md) | Interface, AI output, translation, Telegram and command-line languages (`language.yaml`), adding an interface language |
| [settings.md](settings.md) | The Settings page: AI provider / model / effort dropdowns, manual buttons (collect now, test channels, test AI, Telegram test), rate limits |
| [sources.md](sources.md) | The source list: `sources.yaml`, source ids, the seven states, page actions, import and export, `pnpm sources:list` |
| [deploy.md](deploy.md) | First-deploy checklist (macOS-oriented), `scripts/ops/deploy.sh`, `pnpm run doctor`, upgrade, rollback, a 7-day unattended acceptance table |
| [upgrade.md](upgrade.md) | Upgrading to a release tag (`deploy.sh --ref`), what the deploy does, rolling back, uninstalling |
| [host-setup.md](host-setup.md) | Docker at login, external volumes, power settings, Tailscale, CLI logins on the host, installing the ai-worker, BotFather |
| [multiple-instances.md](multiple-instances.md) | One person = one instance: running a second one beside the first (project, volume and port names), what else to keep apart |
| [backup-restore.md](backup-restore.md) | Automatic `pg_dump` backups, retention, restore drills, disaster recovery |
| [privacy.md](privacy.md) | What is stored, what leaves your machine (AI providers, job sites, Telegram), provider data policies, how to delete everything |
| [commercial-use.md](commercial-use.md) | Using Job Radar in a company or team: AGPL, shared instances, scraping and AI-subscription terms |
| [ai-providers.md](ai-providers.md) | AI via a subscription CLI, an API key, or both: who runs what where, the host ai-worker, `execution` / `host_worker` / `translation` settings, troubleshooting |
| [ai-usage.md](ai-usage.md) | AI usage and cost statistics, model catalog (`models.yaml`) |
| [deal-breakers.md](deal-breakers.md) | Your own veto rules (`preferences.yaml: deal_breakers`): language gate, phrases, visa rule, what happens to a vetoed job, `pnpm deal-breakers:check`, before rolling back |
| [extraction.md](extraction.md) | Rules for work mode, German level, agency detection and description cleanup; `pnpm reprocess` |
| [signals.md](signals.md) | Compensation and benefit signals: tiers, vocabularies, the two-step extraction, the board |
| [salary.md](salary.md) | Salary level on the job page (benchmark of your collected postings, links to salary sites) and the optional AI salary lookup with web search, `salary.yaml` |
| [breakdown.md](breakdown.md) | Job breakdown: manual or automatic, card states and error codes, quote checking, `breakdown.yaml` |
| [ai-traps.md](ai-traps.md) | AI trap detection: what is recognised, which sources only give text, how the text sent to an AI is cleaned, the marks on the pages and in Telegram, `traps.yaml`, `pnpm traps:scan` |
| [score-evidence.md](score-evidence.md) | Reason sources on the job page: JD quote, inferred or not stated, how quotes are checked, the cost, old scores, `ai.yaml: scoring.evidence`, before rolling back |
| [ghost-jobs.md](ghost-jobs.md) | Signs that a posting is not a real opening: the five signals and their points, the list mark and filter, the job page line, "Not a ghost job", `pnpm ghost:check`, settings |
| [visa-sponsorship.md](visa-sponsorship.md) | What a posting says about visa sponsorship or a work permit: the four results, the list badge and filter (for users who need sponsorship), the job page line, the visa deal-breaker, `pnpm visa:scan`, settings |
| [insights.md](insights.md) | The /insights page: how every card is computed, `insights.yaml` |
| [interest-suggestions.md](interest-suggestions.md) | Weekly AI suggestions: evidence rules, approve / reject, `suggest` settings |
| [resume-kit.md](resume-kit.md) | Resume tailoring hand-off: `resume.yaml`, exporting a JD, the `/tailor` command |
| [application-writer.md](application-writer.md) | Your experience library on `/me` (`stories.yaml`): what a story holds, ids, history and rollback, limits in `writer.yaml`, what is sent where |
| [mcp.md](mcp.md) | Asking Claude Desktop, Claude Code or another MCP client about your jobs and applications: the optional read-only MCP server (`pnpm mcp:serve`, `mcp.yaml`), its tools, what it gives and never gives |
| [telegram.md](telegram.md) | Creating a bot, finding your chat id |
| [gmail-alerts.md](gmail-alerts.md) | Two-step verification, app password, the label, subscribing to job alerts |
| [linkedin-session.md](linkedin-session.md) | `pnpm auth:linkedin`, daily page limits, what to do on a verification page |
| [jsearch.md](jsearch.md), [tavily.md](tavily.md), [apify.md](apify.md), [brightdata.md](brightdata.md), [monid.md](monid.md) | Keys, quotas and budgets of the paid or keyed channels |
| [development.md](development.md) | For contributors: code layout, tests, e2e, conventions |
| [roadmap.md](roadmap.md) | What is planned for upcoming releases |
| [ci.md](ci.md) | The CI pipeline explained job by job and step by step: what each runs and why, timings, running it locally, reading failures, e2e projects, Dependabot, release check |
