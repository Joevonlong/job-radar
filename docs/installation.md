# Installation

[English](installation.md) | [中文](installation.zh.md)

This guide takes you from an empty folder to a running Job Radar: the dashboard, AI scoring and, if you want them,
Telegram pushes and phone access. Every command here runs in the project directory (the one with `package.json` and
`compose.yaml`) unless it says otherwise.

Steps 1, 3, 5 and 6 are the core. Everything marked *optional* can wait until later.

## Before you start

### What you need

| | Version | Why |
|---|---|---|
| Docker with Compose 2.24+ | Docker Desktop on macOS; Docker Engine with the compose plugin on Linux. Compose 2.24 or newer (the compose file treats `.env` as optional, which older versions reject) | Runs the dashboard, the runner, the scraping sidecar and the database |
| Node.js | 22 (the project pins `>=22 <23`) | Helper commands and the AI worker, which runs on your machine |
| pnpm | 11 (pinned in `package.json`) | Installs the dependencies for the helper commands |
| git | any recent | Gets the code, and updates it later |
| Disk space | a few GB | The images (the runner image includes a headless browser) and the database |

Check what you have:

```bash
docker compose version
node --version      # v22.x
pnpm --version      # 11.x
git --version
```

No pnpm yet? With Node 22, `corepack enable` gives you the version pinned in `package.json`; `npm install -g pnpm@11`
works too.

Optional, for later:

- **An AI.** A `claude` (Claude Code) or `codex` (Codex CLI) subscription you are signed in to on this machine, or an API
  key for Anthropic, DeepSeek or MiMo. Without one, Job Radar still collects, de-duplicates, filters and shows jobs.
- **Telegram**, for pushes to your phone.
- **Tailscale**, to open the dashboard on your phone.

### macOS, Linux, Windows

- **macOS** is the platform Job Radar is run on every day. For an unattended Mac (Docker at login, restart after power
  loss, external drives), also read [host-setup.md](host-setup.md).
- **Linux** runs everything the same way; a fresh Ubuntu install is tested from scratch in CI. Two differences: the
  containers run as your user (`PUID` / `PGID`, step 3), and the helper script installs the AI worker as a systemd user
  unit instead of a launchd agent (step 5). The Linux host checklist is
  [host-setup.md, section 10](host-setup.md#10-linux).
- **Windows**: run everything inside WSL2, with the checkout in the Linux file system (not under `/mnt/c`) and Docker
  Desktop's WSL integration switched on. The steps are the Linux ones; see the
  [platform notes in the README](../README.md#platform-notes).

## 1. Get the code

```bash
git clone https://github.com/Joevonlong/job-radar.git
cd job-radar
git checkout v2.0.1          # recommended: stay on a release (newest first: git tag --list 'v*' --sort=-v:refname)
```

`main` is the development branch and can change between releases. Staying on a release tag makes updating
predictable (see [Updating](#updating)). Git reports a "detached HEAD" after checking out a tag; that is expected.

## 2. Optional: create `.env`

Every variable has a working local default, so you can skip this for now.

```bash
cp .env.example .env
```

You'll want `.env` when you add a secret: the Telegram bot token, an AI API key, keys for paid or keyed sources (JSearch,
Tavily, Bright Data, Apify, Gmail), a different database password, or extra host names for the dashboard. `.env.example`
explains every variable. `.env` is ignored by git: never commit it, and never paste its contents anywhere.

| Source or feature | Variables | Guide |
|---|---|---|
| Arbeitsagentur, company career pages | none | [sources.md](sources.md) |
| Indeed, StepStone, XING, LinkedIn guest search | none; off in a new install, switching one on asks you to confirm the terms-of-service risk | [sources.md](sources.md#scraping) |
| LinkedIn with your own session | none: a one-time login with `pnpm auth:linkedin` (off by default, read the risks first) | [linkedin-session.md](linkedin-session.md) |
| LinkedIn via Bright Data / Apify (paid) | `BRIGHT_DATA_API_KEY` / `APIFY_TOKEN` | [brightdata.md](brightdata.md), [apify.md](apify.md) |
| Google Jobs via JSearch | `JSEARCH_API_KEY` | [jsearch.md](jsearch.md) |
| Job-alert emails from Gmail | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | [gmail-alerts.md](gmail-alerts.md) |
| Finding new company boards | `TAVILY_API_KEY` | [tavily.md](tavily.md) |
| Telegram pushes | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (written for you by `pnpm run setup --step telegram`) | step 7 below |
| AI via API | `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MIMO_API_KEY` | step 4 below |
| A password for the dashboard | `JOB_RADAR_WEB_PASSWORD_HASH` (from `pnpm web:password`) | step 8 below |
| Linux: the user the containers run as | `PUID`, `PGID` | step 3 below |

After changing `.env`, run `docker compose up -d` so the containers pick it up, and restart the AI worker (step 5) for
AI keys and the Telegram token.

## 3. Start the stack

On Linux, first tell the containers which user owns the checkout (macOS doesn't need this; Docker Desktop maps the
ownership itself):

```bash
sed -i.bak -e "s/^PUID=.*/PUID=$(id -u)/" -e "s/^PGID=.*/PGID=$(id -g)/" .env && rm .env.bak      # Linux only
mkdir -p data/config data/profile data/backups data/exports data/logs .auth
```

The web and the runner write your settings, backups and exports into `data/`. They run as `PUID:PGID` (default
`1000:1000`), so on Linux those ids must own the folders; creating them yourself keeps Docker from creating them as root.

Then start everything:

```bash
docker compose up -d --build      # same as: pnpm stack:up
docker compose ps
```

The first build takes a few minutes. After that, `docker compose ps` should show `db`, `web`, `runner` and `jobspy` as
`healthy` within a minute or two. All four restart by themselves after a reboot (`restart: unless-stopped`) once Docker
is running.

If a service doesn't become healthy:

```bash
docker compose logs --tail 100 web       # or runner, db, jobspy
```

The names in this guide are the defaults: the compose project `job-radar`, the database volume `jobradar-pg`, the
dashboard on port 3000 and the database on host port 5433. A second installation on the same machine needs its own
(`COMPOSE_PROJECT_NAME`, `JOBRADAR_PG_VOLUME`, `JOB_RADAR_WEB_PORT`, `DB_HOST_PORT`), set before its first start:
[multiple-instances.md](multiple-instances.md).

## 4. Sign in to your AI (optional, recommended)

Do this in your own terminal on this machine. Installing the CLIs themselves is covered by their vendors.

| AI | Sign in | Check |
|---|---|---|
| Claude (subscription) | run `claude`, type `/login`, follow the prompts, then exit | `claude auth status` shows `loggedIn: true` |
| Codex (subscription) | `codex login` | `codex login status` shows Logged in |
| API key | add `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` or `MIMO_API_KEY` to `.env` (DeepSeek and MiMo also need `enabled: true` in `ai.yaml`) | `pnpm ai:probe` after step 5 |

Subscription CLIs cost nothing per token; daily caps (codex 200, claude 100 calls by default) protect your quota. API
providers are only tried after the CLIs and stop at `monthly_api_budget_usd` in `ai.yaml`. Don't put a subscription
token into `.env` or a container: the AI worker uses your CLI login directly. More in
[ai-providers.md](ai-providers.md).

## 5. Start the AI worker

The AI worker is a small Node process on your machine (not in Docker). It picks up every AI request from the database,
runs it with your CLI login or API key, writes the result back, and sends the Telegram pushes.

```bash
pnpm install
pnpm ai-worker
```

Leave it running. Start it before the wizard's AI step, so the wizard's **Test** buttons get an answer. While the
worker is off, AI requests simply queue up: the AI worker card on `/sources` shows "not responding", and after three
minutes the runner sends a Telegram alert (if Telegram is on).

Only one AI worker runs per database; a second one exits with code 3 and the message
`another ai-worker is running against this database`. To work through the queue once and exit: `pnpm ai-worker --once`.

### Keep it running in the background

Stop the one in your terminal first (Ctrl-C), then install it as a service that starts at login and restarts after a
crash. The same script works on both systems: a launchd agent on macOS, a systemd user unit
(`job-radar-ai-worker.service`) on Linux.

```bash
scripts/ops/install-ai-worker.sh --dry-run    # prints what it would write, changes nothing
scripts/ops/install-ai-worker.sh
```

Check it:

```bash
# macOS
launchctl print gui/$(id -u)/io.jobradar.ai-worker | grep -E "state|pid"   # state = running
tail -n 20 data/logs/ai-worker.out.log        # errors go to data/logs/ai-worker.err.log

# Linux
systemctl --user status job-radar-ai-worker.service
journalctl --user -u job-radar-ai-worker.service -n 50     # start-up failures; the worker's own logs are in data/logs/
loginctl enable-linger "$USER"                # keep it running while you're logged out (some systems need sudo)
```

Run the script again after upgrading Node or moving `claude` / `codex`. To remove the service:
`scripts/ops/uninstall-ai-worker.sh`.

On Linux the script needs a systemd user session: run it from a normal login, not from `sudo`, `su` or cron. Without
one (a container, WSL without systemd) it says why and changes nothing; then use any supervisor you like, for example a
detached tmux session: `tmux new -d -s jobradar-ai 'pnpm ai-worker'`. Details, including logs on external drives and the
unit template for installing by hand: [host-setup.md](host-setup.md#6b-install-the-ai-worker-host-launchd--you-do-this)
(macOS) and [host-setup.md, section 10](host-setup.md#10-linux) (Linux).

## 6. Run the setup wizard

Open <http://127.0.0.1:3000>. Every page leads to the setup wizard until you finish it.

| Step | What you choose |
|---|---|
| Language | Interface language, language of the AI's texts, language ads are translated into |
| Market | Market pack, country, currency, local language, cities, remote scope, time zone |
| Profile | A short summary for the AI, skills with years, languages with levels, experience, visa, city |
| Targets | Job titles, level, work modes, salary floor, contract types, what to leave out |
| Sources | The job boards of your market and company career pages to add. Sources that scrape a site or use your LinkedIn login start unticked; ticking one shows the terms-of-service risk and asks you to confirm |
| AI | Which CLIs and API providers to use, in what order, which model; a test per provider |
| Telegram (optional) | Push on or off, message language, a test message |
| Review | What each step did, a readiness list, "run the first cycle now", finish |

"Save and continue" writes your config files right away; "Skip" leaves a step for later. Keys and tokens are never
typed into the wizard: it only shows which variables are set in `.env`. Until you finish (or choose "Skip the wizard"),
the runner holds back its scheduled cycles, so nothing is collected with placeholder keywords.


No browser on this machine? The same questions run in the terminal:

```bash
pnpm run setup                 # all eight steps; Enter keeps the value in [brackets]
pnpm run setup --step ai       # one step
pnpm run setup --status        # where the setup stands
```

To open the wizard again later: Settings → Manual actions → "Open the setup wizard", or go to `/setup`. Want a head
start? `pnpm config:example` lists ready-made setups you can apply on top of yours (`--dry-run` shows the changes
first). More: [setup.md](setup.md), [configuration.md](configuration.md).

## 7. Optional: Telegram pushes

Telegram is off until you set it up. Skipping the wizard's Telegram step keeps it off, and the doctor doesn't complain
about a push you haven't switched on.

1. In Telegram, open `@BotFather`, send `/newbot`, follow the prompts, and copy the token (it looks like `123456:ABC-...`).
2. In the project directory, run:
   ```bash
   pnpm run setup --step telegram
   ```
   Paste the token (it isn't shown), then send any message to your bot when asked. The command finds your chat id,
   sends a test message, writes `.env` (with a backup), offers to turn pushes on, and restarts the containers and the
   AI worker so they read the new values. Add `--no-restart` to print the restart commands instead of running them.
3. Check it: Settings → Notifications shows "Connected", and `pnpm run doctor --only telegram` is all ✅.

Prefer to do it by hand (find the chat id with `getUpdates`, edit `.env`, recreate the containers)? See
[telegram.md](telegram.md#doing-it-by-hand).

The bot only accepts messages and button taps from your chat id, and button taps are fetched by long polling, so no
port needs to be open. Pushes and buttons: [telegram.md](telegram.md).


## 8. Optional: open it on your phone (Tailscale)

The dashboard listens on `127.0.0.1:3000` only (the defaults of `JOB_RADAR_WEB_BIND` and `JOB_RADAR_WEB_PORT`), so
nothing is exposed to the internet. Your phone reaches it through Tailscale, a private network between your own devices.

1. Install Tailscale on this machine and on your phone, and sign in with the same account on both.
2. In the Tailscale admin console (DNS), turn on **MagicDNS** and **HTTPS Certificates**.
3. On this machine (use your port if you changed `JOB_RADAR_WEB_PORT`):
   ```bash
   tailscale serve --bg 3000
   tailscale serve status      # prints https://<machine>.<tailnet>.ts.net
   ```
4. Open that address on your phone. Put it into `notify.yaml` as `public_base_url` too, so pushes link to the job page.

Don't use `tailscale funnel`: that puts the dashboard on the public internet (`tailscale serve reset` undoes a serve
rule). Behind another reverse proxy or under a LAN name, add the host name to `JOB_RADAR_ALLOWED_HOSTS` in `.env`, or the
dashboard answers `421 Misdirected Request`
([configuration.md](configuration.md#which-host-names-reach-the-web-job_radar_allowed_hosts)).

### A password, when others can reach it

On this machine the dashboard needs no login. Every device on your tailnet can reach it too, so if anybody else shares
your tailnet, or you open it to the LAN or put it behind a reverse proxy, set a password first:

```bash
pnpm web:password            # asks twice, prints one line: JOB_RADAR_WEB_PASSWORD_HASH=scrypt:...
# paste that line into .env, then:
docker compose up -d web
```

Other devices then get a login page; the browser on this machine still goes straight in. Without a password, a red
banner on every page warns you whenever the dashboard is opened from another machine. To publish it beyond this machine,
set `JOB_RADAR_WEB_BIND` (for example `0.0.0.0`) together with the password; the doctor fails the check otherwise.
Sessions, lockouts and the details: [configuration.md](configuration.md#web-access-optional-password-bind-address-and-port).

## 9. Check everything

```bash
pnpm run doctor
```

It checks Docker, the four services, the database, the runner and AI worker heartbeats, your AI logins, Telegram,
Tailscale, backups, disk space, every enabled source and your config, item by item, as ✅ / ⚠️ / ❌, with what to do
under each problem. It only reads: no AI call, no Telegram message, no cost. Spell it `pnpm run doctor`: plain
`pnpm run doctor` is pnpm's own command. Exit codes: 0 all ✅, 1 some ⚠️, 2 some ❌, 3 the doctor could not run.

On a first install a few items are expected to warn until you set them up: Tailscale and the public address (⚠️);
the paid channels that ship switched on (`linkedin-brightdata`, `linkedin-apify`, `tavily`) until you add their key or
switch them off; the last run and the last backup until the first ones have happened; and `aiworker.launchd` if you
run the worker in a terminal instead of as a service (on Linux this check reads the systemd user unit). LinkedIn is
optional: with no LinkedIn channel set up, the LinkedIn line says so and stays ✅. On Linux, `data.ownership` warns about files under `data/` that don't belong to `PUID`. A Telegram push you
haven't switched on is not reported. The `/sources` page shows the same health in the browser, including the AI worker
card.

The first cycle runs from the wizard's review step, or from Settings → Manual actions → "Run a cycle now". After that, cycles
run on the schedule in `schedule.yaml` (by default weekdays at 07:00 and 17:00, weekends at 09:00, in your time zone).

## Updating

Releases are git tags `vX.Y.Z`. Read the [changelog](../CHANGELOG.md) entry for the release first: it says whether you
need to do anything.

```bash
git status                                     # must be clean (data/ and .env are ignored, that's fine)
git fetch --tags && git tag --list 'v*' --sort=-v:refname
scripts/ops/deploy.sh --ref v2.0.1 --dry-run   # shows every step, changes nothing
scripts/ops/deploy.sh --ref v2.0.1
```

The deploy script checks the tools, checks out the tag, installs dependencies, migrates your config files (originals
kept in `data/config/.backup/`), takes a database backup, rebuilds the images, waits for a running cycle to finish,
restarts the services, migrates the database (with its own backup first), restarts the AI worker service, and runs the
doctor. It stops at the first failing step and tells you what to do; every step is safe to run again.

The AI worker step reinstalls the service from step 5 (launchd on macOS, the systemd user unit on Linux). If you run the
worker under a supervisor of your own, add `--no-ai-worker` and restart it yourself afterwards.

To go back, deploy the previous tag: `scripts/ops/deploy.sh --ref <previous tag>`. If the release you're leaving
migrated the database, also restore the backup the upgrade took. Upgrading on Linux from a version whose containers ran
as root needs a one-time ownership fix first. Details: [upgrade.md](upgrade.md), [deploy.md](deploy.md).

## Backups

The runner backs up every night (03:30 by default) into `data/backups/`: a database dump plus a `.config.tgz` with your
config (`data/config/`) and your profile (`data/profile/`). It keeps the newest backup of each of the last 14 days and of
each of the last 8 weeks. Before a database migration it takes an extra safety backup and migrates only if that
succeeded. `.env` and `.auth/` are in no backup: keep your own copy of them.

```bash
scripts/ops/backup.sh            # a manual backup (database, config and profile); manual backups are never pruned
scripts/ops/restore.sh --list    # all backups, newest first, with their age
scripts/ops/restore.sh --latest --drop  # a drill: restores the newest into a temporary database, compares row counts, then drops it (your data is untouched)
```

A real restore (`--target jobradar --yes`, plus `--with-config` for the config and profile) first restores into a
temporary database, then stops the web, the runner and the AI worker, swaps the databases by renaming them and starts
everything again. The previous database is kept as the safety copy, so picking the wrong file can be undone.

`data/backups/` sits inside the project folder. For protection against a dead disk, copy it somewhere else as part of
your own backup routine; treat the `.config.tgz` files like secrets (they can hold proxy credentials). Everything about
restoring: [backup-restore.md](backup-restore.md).

Never run `docker compose down -v`: `-v` deletes the database volume. To stop the stack, use `docker compose stop` or
`pnpm stack:down`.

## Uninstalling

**This deletes the database, your profile, your config and your logins, and can't be undone.** Make a last backup and
copy it somewhere safe first (`scripts/ops/backup.sh`, then copy `data/backups/`; keep `data/profile/` and
`data/config/` too if you might come back).

```bash
# 1. the AI worker service (launchd on macOS, the systemd user unit on Linux)
scripts/ops/uninstall-ai-worker.sh --purge-logs

# 2. containers and network (this checkout's compose project)
docker compose down

# 3. the database volume (all jobs, applications and AI results); jobradar-pg unless you set JOBRADAR_PG_VOLUME
docker volume rm jobradar-pg

# 4. local data, secrets and logs
rm -rf data .auth .env
rm -rf ~/Library/Logs/job-radar                          # macOS only

# 5. the checkout
cd .. && rm -rf job-radar
```

`docker image prune` removes the built images. If you set up Docker at login, power settings or Tailscale for Job
Radar, undo those by hand. Your `claude` and `codex` logins are yours and stay. More: [upgrade.md](upgrade.md#uninstall).

## Troubleshooting

| You see | What to do |
|---|---|
| `pnpm doctor` prints something about pnpm itself | Use `pnpm run doctor`. |
| `Cannot connect to the Docker daemon` | Start Docker: `open -a Docker` on macOS, `sudo systemctl start docker` on Linux. |
| `docker compose` rejects `env_file` or `required` | Your Compose is older than 2.24. Update Docker Desktop or the compose plugin. |
| A port is already in use | Pick other ports in `.env`: `JOB_RADAR_WEB_PORT` for the dashboard (default 3000), `DB_HOST_PORT` for the database (default 5433). Then `docker compose up -d`. |
| The wizard says it couldn't save (Linux) | `data/` doesn't belong to the user the containers run as. Set `PUID` / `PGID` in `.env` to `id -u` / `id -g`, run `sudo chown -R "$(id -u):$(id -g)" data .auth` once, then `docker compose up -d`. The doctor's `data.ownership` check lists what's wrong. |
| The AI worker card on `/sources` says "not responding" | Is `pnpm ai-worker` (or the launchd / systemd service) running? Look at its log (`data/logs/ai-worker.err.log` on macOS, `journalctl --user -u job-radar-ai-worker` with systemd). |
| Jobs come in but never get a score | Check `claude auth status` / `codex login status`, then `pnpm ai:probe`. If the doctor shows `ai.profile` ❌, open `/me` and fill in a summary or skills: scoring waits for a profile. |
| `another ai-worker is running against this database` | One is already running (often the launchd or systemd service). That's fine; stop it first if you want to run one by hand. |
| Nothing is collected | Finish or skip the setup wizard; the doctor's `setup.completed` and `cycle.last` explain what the runner is waiting for. |
| A source says "not configured" | Its key is missing from `.env`. Add it and run `docker compose up -d`, or switch the source off. |
| A login page you didn't expect | A password is set in `.env` (`JOB_RADAR_WEB_PASSWORD_HASH`). Sign in, or remove the line and run `docker compose up -d web`. If no password can sign in, the hash was copied incompletely: run `pnpm web:password` again. |
| `421 Misdirected Request` | You opened the dashboard under a host name it doesn't know. Use `127.0.0.1`, a `*.ts.net` address, or add the name to `JOB_RADAR_ALLOWED_HOSTS`. |
| `pnpm telegram:test` says `chat not found` | The chat id is wrong, or you haven't pressed Start in your bot. |
| Telegram buttons do nothing | Another program uses the same bot token (`getUpdates` returns 409 in the runner log). Give Job Radar its own bot. |

Still stuck? Run `pnpm run doctor --json`, remove anything personal, and open an issue. Daily use, the pages and the
logs: [usage.md](usage.md).
