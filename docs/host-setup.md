# Host setup (running unattended on a Mac)

This page is the macOS guide. On Linux or Windows (WSL2) see the [platform notes](installation.md#macos-linux-windows); the sections here about Docker Desktop, power settings, automatic login and launchd do not apply there.

Goal: after the Mac is powered on it logs in by itself, Docker starts by itself, the four services (db / web / runner / jobspy) recover by themselves, the AI worker on the host is started by itself, and your phone can view the dashboard over Tailscale.

AI uses your own local Claude Code / Codex **subscriptions** and/or an API key: the containers hold no AI credentials, and AI work and push messages are performed by the `ai-worker` on the host (launchd); see sections 6 and 6b.

Convention: steps marked **[You do this]** can only be done by you personally (clicking system dialogs, typing passwords, logging in to accounts); an agent cannot and should not do them for you. Unmarked commands can be copied and run directly (or handed to an agent).

On Linux, sections 1 to 3 and the launchd part of 6b do not apply: read [section 10](#10-linux) first.

All commands run in the project directory (the one that contains `package.json`, `compose.yaml`, `config/` and `data/`; for example `~/job-radar`), including the compose commands.

## 0. Prerequisites

- If the project lives on an external volume (for example `/Volumes/Data`): the volume is mounted and its mount point has the name you expect (a duplicate such as `Data 1` means the last unmount was not clean; sort that out before continuing).
- Docker Desktop is installed (`/Applications/Docker.app`).
- The repository is cloned and `pnpm install` passes.

## 1. Let Docker Desktop read and write the external volume  **[You do this]**

Skip this section if the project is on the internal disk.

The containers read and write `config`, `data/config`, `data/profile` and `data/backups` in the project directory. macOS protects external volumes with a privacy prompt on first access.

1. Open Docker Desktop → Settings → Resources → File sharing and confirm the list contains `/Volumes` (usually present by default).
2. Open System Settings → Privacy & Security → Files & Folders → Docker and turn on "Removable Volumes". If Docker is not in the list, first do step 5 so a container accesses the volume once, click "Allow" when the prompt appears, then come back and confirm.
3. If reading or writing `/app/config` inside a container later fails with `Operation not permitted`: System Settings → Privacy & Security → Full Disk Access → add Docker, then restart Docker Desktop.

## 2. Docker Desktop starts at login  **[You do this]**

1. Docker Desktop → Settings → General → tick "Start Docker Desktop when you sign in to your computer".
2. If this option will not stay on (Docker's settings show `AutoStart` off and an error such as "operation is not permitted when registering app service"): go to System Settings → General → Login Items & Extensions, turn on Docker under "Allow in the Background", then go back to step 1 and tick it again.
3. Check: after restarting Docker Desktop the option is still ticked.

Docker Desktop is a program in the user session: **it only starts when a user is logged in**. So also make the Mac log in automatically after boot: System Settings → Users & Groups → "Automatic login" and pick your account (this requires turning FileVault off, which leaves the disk readable by anyone with physical access: **only do this on a dedicated machine you do not carry around**; it is your own security trade-off, and an agent does not decide it for you). Skip it on a laptop or a machine with other uses and log in yourself after a reboot.

## 3. Auto power-on after power loss, and no sleep  **[You do this]** (needs the admin password)

```bash
sudo pmset autorestart 1      # power on automatically after power is restored
sudo pmset -a sleep 0         # never enter system sleep (the display may still turn off)
sudo pmset -a womp 1          # allow wake on network (optional)
```

Check (no sudo needed, an agent can run it too):

```bash
pmset -g | grep -E "autorestart|sleep|womp"
```

You should see `autorestart 1` and `sleep 0`.

## 4. Start the whole stack

```bash
mkdir -p data/profile data/backups      # create the mount directories first, so Docker does not create them as root
cp .env.example .env                    # first time only; .env is gitignored, do not commit it
docker compose config > /dev/null       # syntax check; no output means it is correct
docker compose up -d --build            # same as pnpm stack:up; the first time it builds images and takes a few minutes
docker compose ps
```

In `docker compose ps`, db, web, runner and jobspy should all be `healthy`. The runner's status comes from its healthcheck (see section 8).

On the first run you can leave `.env` empty: every variable has a default (on Linux set `PUID` / `PGID`, see section 10). The runner and the jobspy sidecar are capped at 2 GB and 1 GB of memory
(`RUNNER_MEM_LIMIT`, `JOBSPY_MEM_LIMIT` in `.env`); a service that hits its cap is killed and restarted. The containers need no AI login or keys (`~/.codex/auth.json` is no longer mounted); AI runs on the host, see section 6.

## 5. Recovering by itself after a restart (verify once)

All compose services use `restart: unless-stopped`: after Docker starts it brings back the containers that were not stopped manually. If the runner starts before db it fails to connect and exits, and the restart policy brings it back again until db is available.

Verify (this interrupts the service for a few tens of seconds):

1. Quit Docker Desktop (menu bar icon → Quit Docker Desktop), then open it again.
2. `docker compose ps`: within a minute or two the four services return to `healthy`.
3. `docker compose logs --tail 20 runner`: you should see `migrations up to date`, `catch-up: ...` and `heartbeat every 30s`.

If the external volume mounts later than Docker, containers fail to start because the bind-mount source directory does not exist: after the volume is mounted, run `docker compose up -d`.

## 6. Accounts and tokens  **[You do this]**

Do all of the following in your own terminal. Never paste tokens into a chat or commit them to git.

### Claude (claude-cli provider)

1. Run `claude` in a terminal, type `/login` and follow the prompts to log in with your subscription account; then exit the session. The login is stored in the macOS keychain and the ai-worker on the host uses it directly. Do **not** also generate a `claude setup-token`, and do not put a token into `.env` or a container.
2. When the login expires (the AI worker card on `/sources` or a Telegram alert mentions auth), repeat step 1; there is no need to restart the worker.

### Codex (codex-cli provider)

1. `codex login` (browser login); check with `codex login status`.
2. The login is stored in `~/.codex/` and the ai-worker reads it directly; after switching accounts or when it expires, run `codex login` again.

### Telegram

1. In Telegram find @BotFather → `/newbot`, follow the prompts to name it, and get the bot token.
2. Send your bot a message, then open `https://api.telegram.org/bot<token>/getUpdates` in a browser to find `chat.id`.
3. Put the token and chat id into `.env`; see [telegram.md](telegram.md) for the exact variable names.

## 6b. Install the AI worker (host, launchd)  **[You do this]**

The AI worker is a Node process on the host. It polls the database for AI requests (each cycle's `run_ai`, "translate" and "re-score" from the web UI), runs them with the `claude` / `codex` you logged in above, and then sends the Telegram pushes. While it is not running, AI requests queue up, the AI worker card on `/sources` shows "no response", and after `ai.yaml: host_worker.offline_after_seconds` (default 180 seconds) the runner sends a Telegram alert.

Prerequisites: `pnpm install` is done in the main checkout, `claude` and `codex` are on PATH (for example in `~/.local/bin`), and the database in Docker is running: run `docker compose up -d` (section 4) first, or at least `docker compose -p job-radar up -d db`. The install waits for the new worker to hold its database lock and write a heartbeat, so without the database it rolls back.

```bash
scripts/ops/install-ai-worker.sh --dry-run    # only prints the plist (password masked), changes nothing
scripts/ops/install-ai-worker.sh              # builds the release of HEAD, writes ~/Library/LaunchAgents/io.jobradar.ai-worker.plist, bootstraps it
scripts/ops/install-ai-worker.sh --print-release   # the release directory the installed worker runs from
launchctl print gui/$(id -u)/io.jobradar.ai-worker | grep -E "state|pid"     # should be state = running
tail -n 20 data/logs/ai-worker.out.log                                   # logs; errors are in ai-worker.err.log
tail -n 20 ~/Library/Logs/job-radar/ai-worker.launchd.log                         # only start failures and crashes are written here
```

The script: runs the worker from a read-only **release directory** `data/releases/ai-worker/<commit>/` of the main checkout (even if you run it from a worktree; `--root <checkout>` names another one). Without `--release <dir>` it first builds the release of HEAD with `scripts/ops/prepare-release.sh`; `deploy.sh` passes the release it built. The code and the shipped `config/` come from the release; `.env`, `data/config`, `data/profile` and `data/logs` from the main checkout. It replaces a running worker only once the new one is proven ready, and otherwise puts the old one back (see [deploy.md](deploy.md), "The ai-worker runs from a release directory"). It writes the **absolute paths** of node / claude / codex / pnpm and PATH, points `DATABASE_URL` at `127.0.0.1:5433` (reading POSTGRES_* or `DATABASE_URL` from `.env`; the password is written only into the plist with mode 600 and is never printed), uses `KeepAlive` so the process is restarted after it exits or is killed, and starts automatically at login. **Label rename:** the launchd label used to be `de.jobradar.ai-worker`. `install-ai-worker.sh` (and therefore `deploy.sh`) migrates automatically and idempotently: if an agent with the old label is loaded or its plist exists in `~/Library/LaunchAgents/`, it is booted out and the old plist is removed before the new `io.jobradar.ai-worker` agent is bootstrapped. `uninstall-ai-worker.sh` removes both labels. If a user config `data/config/schedule.yaml` still has `doctor.ai_worker_launchd_label: de.jobradar.ai-worker`, the doctor treats it as the new label.

After reinstalling or upgrading node or moving `claude`, just run the script again (it replaces the loaded one). The previous release directories are kept (`schedule.yaml: deploy.ai_worker_releases_keep`, 3).

Logs: launchd **itself** cannot open files on an external volume (when the plist's `StandardOutPath` points to an external volume the job exits at once with `EX_CONFIG`, verified on macOS), but the node process it starts can read and write the external volume. So the plist passes the worker `--log-dir <main checkout>/data/logs`, and the worker writes its own output to `ai-worker.out.log` / `ai-worker.err.log` (`data/` is gitignored); when a file exceeds `ai.yaml: host_worker.log_max_mb` (10 MB) it is rotated to `.1`, `.2`, ..., keeping `log_keep` (3) copies. launchd's own output file `~/Library/Logs/job-radar/ai-worker.launchd.log` stays on the internal disk and only catches output and crashes from before the worker opens its log; it also has a size cap, and rotated old copies go to `data/logs/`. Do **not** change the plist's `StandardOutPath` / `StandardErrorPath` to an external volume, or the ai-worker will not start at all (details in section 2 of [deploy.md](deploy.md)). If the worker cannot open `data/logs` (volume not mounted, permissions) it writes one line with the reason into launchd's file and falls back to writing there. Versions installed earlier wrote logs to `~/Library/Logs/job-radar/ai-worker.{out,err}.log`: after the next successful install they are appended to `data/logs/ai-worker.{out,err}.before-upgrade.log` and removed (a failure to move them only prints a warning).

Shutdown: the plist starts the worker directly with `node --import <the release's tsx loader> src/ai-worker/index.ts` from the release directory (not through the `tsx` CLI parent process, so launchd tracks the worker itself; `NODE_OPTIONS` is set empty so nothing else is preloaded) and sets `ExitTimeOut` to `schedule.yaml: deploy.ai_worker_stop_timeout_seconds` (60 seconds). After SIGTERM the worker has `ai.yaml: host_worker.shutdown_grace_seconds` (30 seconds) to finish the current request and database connections; on timeout it logs `ERROR shutdown did not finish within …: forcing exit` and exits with code 1 by force, and launchd restarts it; a second signal exits immediately. A request the shutdown cuts off is not lost: it goes back to the queue and runs again after the restart (`host_worker.requeue_interrupted_max`, see [deploy.md](deploy.md#work-interrupted-by-a-restart)). Heartbeat writes and disk measurement each have a timeout, `host_worker.step_timeout_seconds` (20 seconds), and disk measurement and the heartbeat loop do not block each other (under launchd, reading Docker's settings file can be stuck behind a macOS privacy prompt). After an upgrade, `deploy.sh` switches the worker to the new release (step 10); without `deploy.sh`, run `scripts/ops/install-ai-worker.sh` again.

Notes:
- The ai-worker runs from a release directory on the external volume; if the volume is not yet mounted at boot, launchd retries every 10 seconds until it succeeds. The first time it accesses the external volume macOS may show "allow node to access removable volumes"; click Allow.
- The Telegram token / chat id are read from `.env` (like the runner); pushes are sent by the worker, so while the worker is offline there are no job pushes.
- To run the queue once without installing the service: `pnpm ai-worker --once`.

Uninstall:

```bash
scripts/ops/uninstall-ai-worker.sh            # launchctl bootout + delete the plist (logs are kept; --purge-logs also deletes the ai-worker logs in data/logs and ~/Library/Logs/job-radar)
```

## 7. Phone access: Tailscale  **[You do this]**

web binds only to `127.0.0.1:3000` (nothing is opened to the public internet); your phone reaches it over Tailscale.

1. Open Tailscale on the Mac (`/Applications/Tailscale.app`) and log in; if it shows "Tailscale is stopped", click Connect first. Install Tailscale on your phone and log in with the same account.
2. In the Tailscale admin console (login.tailscale.com → DNS) enable MagicDNS and HTTPS Certificates (`tailscale serve` needs them for https).
3. In a terminal on the Mac run:

```bash
tailscale serve --bg 3000
tailscale serve status
```

`status` prints an address of the form `https://<machine>.<tailnet>.ts.net`; open it in your phone's browser. It is visible only inside your tailnet.

4. Do not use `tailscale funnel`: it exposes the page to the public internet. To undo, use `tailscale serve reset`.
   The web answers only `localhost`, `127.0.0.1`, `[::1]` and `*.ts.net`. Behind another reverse proxy (Caddy, nginx;
   it must forward `Host` or `X-Forwarded-Host`) or under a LAN name, add that name to `JOB_RADAR_ALLOWED_HOSTS` in `.env` (see
   [configuration.md](configuration.md#which-host-names-reach-the-web-job_radar_allowed_hosts)); otherwise it answers
   `421 Misdirected Request`.
5. Make Tailscale start at login: tick "Start at login" in Tailscale's settings (menu bar icon → Settings).
6. Optional web password. Your tailnet is yours alone: the dashboard is then only as open as your devices are. When you
   share the tailnet, open the web on the LAN (`JOB_RADAR_WEB_BIND`) or put a reverse proxy in front, set a password:

```bash
pnpm web:password            # asks twice, prints JOB_RADAR_WEB_PASSWORD_HASH=...
# paste that line into .env, then
docker compose up -d web
```

   The phone then shows a sign-in page once (the session lasts 30 days); the browser on the Mac itself needs no password.
   Without a password, a red banner on every page reached through `tailscale serve` reminds you. Details, limits and the
   other variables: [configuration.md](configuration.md#web-access-optional-password-bind-address-and-port).

## 8. Day-to-day checks

One command shows everything: `pnpm run doctor` (item by item ✅ / ⚠️ / ❌ with fix hints, see [deploy.md](deploy.md)). Below are the single-item commands behind it, for troubleshooting:

```bash
docker compose ps                                   # status and health of the four services
docker compose logs --tail 50 runner                # recent runner logs
docker inspect --format '{{json .State.Health}}' job-radar-runner-1   # the runner healthcheck's last few results
ls -lh data/backups                                 # backup files (see backup-restore.md)
```

Runner healthcheck: every 30 seconds the container runs `node dist/healthcheck.mjs`, which reads the latest runner heartbeat from the database. If there is no new heartbeat for longer than `RUNNER_HEALTH_MAX_AGE_SECONDS` (default 120 seconds, 4 times the heartbeat interval), or the database cannot be reached, it records a failure, and after 3 failures in a row the container status becomes `unhealthy`.

Note: `unhealthy` is only a status. Docker's `restart: unless-stopped` restarts only when the process exits, not because of unhealthy. If the runner is `unhealthy`: first `docker compose logs --tail 100 runner` to see why, then `docker compose restart runner`.

The runner also has its own watchdog: it stops waiting for a heartbeat write after `RUNNER_HEARTBEAT_SECONDS`.
A successful write clears the failure window even if it finishes after that timeout. Continuous failures without a
successful write for twice `RUNNER_HEALTH_MAX_AGE_SECONDS` start a shutdown so Docker can restart it. Active work is
aborted and gets up to `ai.yaml: host_worker.shutdown_grace_seconds` to clean up before a forced exit.
Heartbeat pruning and the ai-worker check use the same per-step timeout; their failure is logged without blocking later
heartbeats. These timeouts stop waiting for a query; they do not cancel a query already running in Postgres.

Log rotation: all services use the json-file driver, with at most `LOG_MAX_FILE` files per service (default 5), each at most `LOG_MAX_SIZE` (default 10m); both can be changed in `.env`.

Day-to-day checks for the AI worker: the AI worker card on the `/sources` page (heartbeat, number of queued AI requests, result of the latest `run_ai`); on the command line `launchctl print gui/$(id -u)/io.jobradar.ai-worker`. Logs are in `data/logs/`, and the worker rotates them by size automatically (see section 6b), so you do not need to clean them by hand.

Docker disk usage: after every deployment `scripts/ops/deploy.sh` trims the build cache to `schedule.yaml: deploy.build_cache_keep_gb` (default 5 GB) and deletes dangling images; it never touches data volumes. To see usage by hand: `docker system df`. If your internal disk is small, move the Docker data directory to an external volume.

## 9. Where the data lives

- The database is in the Docker named volume `jobradar-pg`, inside Docker Desktop's disk image. The image is in the data folder set in Docker Desktop's settings (`DataFolder`): by default on the internal disk under `~/Library/Containers/com.docker.docker`; if your internal disk is small you can move it to an external volume (doctor's `disk.docker_location` checks whether it is on the same volume as the project). Wherever it is, the disk image is not an ordinary file, and the pg_dump files in `data/backups/` are the regular copy of the data; see [backup-restore.md](backup-restore.md).
- The ai-worker's logs are in `data/logs/` (section 6b).
- The volume name is `jobradar-pg` unless `.env` sets `JOBRADAR_PG_VOLUME` (only a second instance does, see
  [multiple-instances.md](multiple-instances.md)); never change it for an existing install.
- Never run `docker compose down -v`: `-v` deletes the database volume. To stop services use `docker compose stop` or `pnpm stack:down` (without `-v`).

## 10. Linux

The stack runs the same on Linux (tested from scratch on Ubuntu 24.04 by the `linux-smoke` CI job). What differs from the
Mac:

- **Docker**: Docker Engine with the compose plugin (`docker compose version`). Docker starts at boot through systemd
  (`sudo systemctl enable --now docker`); the containers restart by themselves (`restart: unless-stopped`). There is no
  Docker Desktop, `pmset` or launchd: sections 1 to 3 do not apply.
- **File ownership**: the web and the runner write into `data/` (config files with mode 0600, backups, exports). On Linux
  the containers run as `PUID:PGID` (default `1000:1000`); set them to the user that owns the checkout, before the first
  `docker compose up`:

```bash
# .env.example already has empty PUID= and PGID= lines: fill those in (do not append a second pair)
sed -i.bak -e "s/^PUID=.*/PUID=$(id -u)/" -e "s/^PGID=.*/PGID=$(id -g)/" .env && rm .env.bak
mkdir -p data/config data/profile data/backups data/exports data/logs .auth   # as this user, not root
docker compose up -d --build
```

  If the folders were created by Docker as root, fix them once: `sudo chown -R "$(id -u):$(id -g)" data .auth`
  (upgrading an older install: [upgrade.md](upgrade.md#linux-upgrading-from-a-version-whose-containers-ran-as-root)).
  `pnpm run doctor` warns about files that do not belong to `PUID` (`data.ownership`).
- **AI worker (section 6b)**: `scripts/ops/install-ai-worker.sh` installs a systemd **user** unit,
  `~/.config/systemd/user/job-radar-ai-worker.service` (mode 0600: it holds `DATABASE_URL`), instead of the launchd agent:

```bash
scripts/ops/install-ai-worker.sh --dry-run    # prints the unit (password masked), changes nothing
scripts/ops/install-ai-worker.sh              # builds the release of HEAD, writes the unit, daemon-reload, enable, start
systemctl --user status job-radar-ai-worker.service
journalctl --user -u job-radar-ai-worker.service -n 50     # start-up failures; the worker's own logs are in data/logs/
loginctl enable-linger "$USER"                # keep it running while you are logged out (some systems need sudo)
scripts/ops/uninstall-ai-worker.sh            # disable --now and remove the unit
```

  As on macOS, start the database first (`docker compose up -d`), and the worker runs from a release directory
  (`WorkingDirectory=` of the unit; `TimeoutStopSec` is `deploy.ai_worker_stop_timeout_seconds`).
  Without a systemd user session (a container, WSL without systemd) the script says so, and why, and changes nothing.
  Run from `sudo`, `su` or cron, `XDG_RUNTIME_DIR` is missing: run it from a normal login of the user. Over SSH on a
  server where the user has no session manager: `sudo loginctl enable-linger <user>`, log in again. Otherwise run
  `pnpm ai-worker` under the supervisor you use. The uninstall script leaves a unit file it cannot stop in place and says
  why. `JOB_RADAR_SERVICE_MANAGER=systemd|launchd|none` overrides the detection.
  The template is `scripts/ops/systemd/job-radar-ai-worker.service` if you install it by hand. The doctor's
  `aiworker.launchd` check reads `systemctl --user show` on Linux.
- **Backups** run inside the runner container (no host timer needed); see [backup-restore.md](backup-restore.md).
- **Phone access**: Tailscale works the same (`tailscale serve --bg 3000`). On a server reached by others, set a web
  password (section 7, step 6).
