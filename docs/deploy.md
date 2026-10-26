# Deploy, upgrade, roll back, and the 7-day unattended acceptance run

This guide deploys Job Radar onto a host for real and explains how to confirm it keeps running unattended. The host-specific steps (Docker Desktop, power settings, launchd) are written for macOS; on Linux or Windows (WSL2) follow the [platform notes](installation.md#macos-linux-windows) and use the platform-independent parts (the deploy script, doctor, upgrade and rollback).

- First deployment: work through the checklist in section 1, then run `scripts/ops/deploy.sh` (section 2).
- Day to day: `pnpm run doctor` (section 3) tells you at a glance whether the system is healthy and what is missing.
- Upgrade and rollback: sections 4 and 5.
- 7-day unattended acceptance: section 6. Keep your own log (for example `unattended-<date>.md`).

Convention: steps marked **[You do this]** can only be done by you personally (clicking system dialogs, typing passwords, logging in to accounts, pasting tokens); an agent cannot and should not do them for you. Write tokens and passwords only into `.env` or the respective login screens. Never paste them into a chat and never commit them to git. Commands run in the project directory (the one that contains `package.json`, `compose.yaml`, `config/` and `data/`) unless stated otherwise.

## 1. Checklist before the first deployment  **[You do this]**

Tick each item when done (items 2 and 3 are macOS-specific and can be skipped elsewhere). Details are in [host-setup.md](host-setup.md); this table only gives the order and "how to confirm it is right".

| # | What to do | Details | How to confirm |
|---|---|---|---|
| ☐ 1 | If the project lives on an external volume: it is mounted correctly (no duplicate like `Data 1`), and Docker Desktop can read and write it | host-setup sections 0 and 1 | `ls /Volumes` shows the volume once; the first step of the deploy script checks this |
| ☐ 2 | Docker Desktop starts at login; the Mac logs in automatically after boot | host-setup section 2 | After rebooting the Mac, without clicking anything, `docker info` returns |
| ☐ 3 | Auto power-on after power loss, no sleep: `sudo pmset autorestart 1`, `sudo pmset -a sleep 0` | host-setup section 3 | doctor's "Mac restarts after power loss, no sleep" check is ✅ |
| ☐ 4 | claude and/or codex are logged in on the host, or an API key is set in `.env` | host-setup section 6 | In a terminal `claude auth status` shows `loggedIn: true` and `codex login status` shows Logged in |
| ☐ 5 | Telegram: create a bot with @BotFather, put the token and chat id into `.env`; set `telegram.enabled: true` in `notify.yaml` | [telegram.md](telegram.md), host-setup section 6 | `pnpm telegram:test` delivers a test message to your phone |
| ☐ 6 | Collection-channel keys (Bright Data, Apify, Monid, Tavily, JSearch, Gmail, ...) go into `.env` as needed, and confirm each channel's monthly budget | The per-channel guides ([brightdata.md](brightdata.md), [apify.md](apify.md), [monid.md](monid.md), etc.); `.env.example` lists the variable names | doctor's "channels and budget" section has no "missing XXX" |
| ☐ 7 | Profile: write `data/profile/me.yaml` and `preferences.yaml`. Config: `pnpm config:init` creates the user config directory `data/config/` (edit config there from now on, see [configuration.md](configuration.md)) | `config/profile.example/` | `pnpm config:check` passes everywhere |
| ☐ 8 | Tailscale: open it on the Mac and Connect, tick Start at login; install it on your phone with the same account; `tailscale serve --bg 3000`; write the address from `tailscale serve status` into `notify.yaml: public_base_url` | host-setup section 7 | Your phone's browser opens that address; doctor's three "phone access" checks are ✅ |
| ☐ 9 | LinkedIn login state (optional, once the `linkedin-session` channel is enabled) | [linkedin-session.md](linkedin-session.md) | doctor's "LinkedIn cascade available, login state" check has no ⚠️ |
| ☐ 10 | `cp .env.example .env` (first time only), fill in the values for 4, 5 and 6 | `.env.example` | `.env` is in `.gitignore`; `git status` does not show it |

Do not use `tailscale funnel` (it exposes the page to the public internet). Never run `docker compose down -v` (it deletes the database volume).

## 2. Deploy: `scripts/ops/deploy.sh`

First look at what it will do (prints only, changes nothing):

```bash
scripts/ops/deploy.sh --dry-run
```

The output lists 13 steps and the command each one runs. If a precondition is not met right now (for example you are not on main, or there are uncommitted changes), it is marked with `⚠ a real run would stop here`. When it looks right:

```bash
scripts/ops/deploy.sh
```

Run it in the **main checkout** (not in a worktree or feature branch; without `--ref` it follows `main`, with `--ref <tag>` it checks out that tag and leaves git on a detached HEAD; the ai-worker runs from a release directory of the deployed commit under `data/releases/ai-worker/`, see "The ai-worker runs from a release directory" below). The script runs the steps in order and **stops at the first failure**, telling you which step, why, and what to do. Steps already completed are not rolled back; fix the problem and run again (every step is idempotent):

| Step | What it does | Usual failure |
|---|---|---|
| 1 preflight | The terminal does not stop background output (`tostop` unset); takes the deploy lock (one deploy at a time, see "One deploy at a time" below) and removes build contexts that earlier, interrupted deploys left in `data/build/`; git / docker / node / pnpm are present, Docker is running; no uncommitted changes to tracked files (in every mode, `--skip-pull` too, see "Build context and a clean checkout"); the external volume is not mounted twice | Docker Desktop is not up; uncommitted changes; another deploy holds the lock; `stty tostop` is set (run `stty -tostop`) |
| 2 pull | Without `--ref`: you are on main and, after `git fetch`, it fast-forwards to `origin/main`. With `--ref <tag>`: it fetches the tag (or branch), refuses a version whose ai-worker cannot run from a release directory (before the checkout moves; see [upgrade.md](upgrade.md#downgrade-pre-release-dir)) and checks it out. Then the commit to deploy is fixed: every later step uses it, and the steps from install to the ai-worker stop if HEAD moved or tracked files changed meanwhile | You are on another branch (without `--ref`); unpushed local commits (diverged); `checkout moved during deploy` (another git command ran in the checkout during the deploy); `--ref` names a version from before release directories |
| 3 install | `pnpm install --frozen-lockfile` | Network |
| 4 config | Creates data folders. Existing install: `pnpm config:migrate` (preview only), `pnpm config:check` in memory, compose config, then `pnpm ops:freeze --target <commit>`. First install: `config:init`, without a freeze. Also checks `.env` | Invalid YAML, a newer config version, or unavailable write locks |
| 5 backup | If db is already running, take a `pre-deploy` backup first (skipped on the first deployment) | If the backup fails the upgrade does not continue |
| 6 build | Unpacks `git archive` of the commit fixed in step 2 into `data/build/<commit>-<pid>/` and runs `docker compose -p job-radar build` with that directory as the build context (`JOB_RADAR_BUILD_CONTEXT`). The images contain exactly the committed files, the shipped defaults of `config/` included | Disk full |
| 7 release | `scripts/ops/prepare-release.sh <commit> --root <checkout>`: builds the ai-worker's release directory `data/releases/ai-worker/<commit>/` (a `git archive` of the commit plus its production dependencies, read-only) unless it already exists and is complete | Network or disk (the dependency install) |
| 8 up | First `pnpm ops:drain`: if a cycle is running, wait for it to finish (up to `schedule.yaml: deploy.drain_timeout_seconds`, 900 seconds), because recreating the runner would cut it off. Then `docker compose up -d --wait`: db / web / runner / jobspy must all become healthy (up to 300 seconds) | A service does not start: the script lists `docker compose ps` and the command to view logs. A cycle still running after the wait only prints a warning (`pnpm ops:drain` exit code 1), and so does a check that could not be made (exit code 3: config or database error, or a query that hung): the deployment carries on and the runner re-runs that scheduled slot when it starts (catch-up) |
| 9 migrate | `pnpm migrate:run` (the runner also migrates automatically on start; this is a confirmation, and does nothing if already up to date). When a migration is pending, a `premigrate` backup (database and config archive) is taken first, and the migration does not run if that backup fails (`backup.pre_migrate` in `schedule.yaml`) | Bad migration SQL; the pre-migration backup failed |
| 10 ai-worker | `scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<commit>`: switches the ai-worker (a launchd agent on macOS, the systemd user unit `job-radar-ai-worker.service` on Linux) to the release of step 7, and rolls back to the previous one when the new worker shows no evidence (see "The ai-worker runs from a release directory" below). An AI request it is working on (for example a `run_ai` scoring a whole cycle) is not lost: it goes back to the queue and runs again after the restart (see "Work interrupted by a restart" below) | The output starts with `not changed:` (nothing was touched), `rolled back:` (the previous worker runs again) or `ROLLBACK FAILED:` (follow the message); `claude` / `codex` not on PATH |
| 11 config-write | Confirms the target worker service PID with a fresh lock/heartbeat/report receipt, scans host worker processes and probes `worker-heartbeat.ts --holder --pid <expected> --host <host>`. A matching target service PID, or no holder and no installed service, plus a successful process scan with no other worker, permits token-authorized `config:init` and `config:migrate --write`. Re-plans before unfreezing. A first install has no token and skips the gate; `--settle 0` checks the service release/PID/holder and process scan like `--no-ai-worker`, without a receipt wait. | Old/unknown holder, other worker PIDs or failed process scan: no writes, freeze kept, pending (2). Safe consumers but failed/skipped writes: unfreeze, pending (2) |
| 12 prune | First releases the deploy lock and removes the build context of step 6. Then cleans up Docker: keeps the build cache by most recent use down to `schedule.yaml: deploy.build_cache_keep_gb` (`docker builder prune -f --max-used-space 5gb`), removes dangling images (`docker image prune -f`, without `-a`). Never touches data volumes and never removes images in use | Never fails the deployment: a command error just prints ⚠ and continues (for example an old Docker that does not know `--max-used-space`) |
| 13 doctor | `pnpm run doctor`, including `config.freeze` for a leftover upgrade freeze | Doctor problems return exit 2; warnings alone return 0 |

Options: `--skip-pull` (leave git alone and deploy the current code; used for rollback), `--no-backup`, `--no-prune` (skip the Docker cleanup in step 12), `--no-ai-worker` (skip steps 7 and 10 and the step 11 worker wait), `--no-drain` (do not wait for a running cycle in step 8), `--drain-timeout SECONDS` (instead of `deploy.drain_timeout_seconds`), `--ref <tag|branch>` (deploy a release tag such as `v2.0.0` instead of `main`, see [upgrade.md](upgrade.md)), `--branch`, `--remote`, `--wait-timeout SECONDS`, `--settle SECONDS` (maximum worker wait from the start of step 11, before config writes and prune; 0 skips it); see `--help` for all of them.

The settings for deployment and config write locks are in the `deploy` block of `schedule.yaml`; deployment options take effect on the next deploy, lock options on subsequent writes. The deploy and backup scripts read `schedule.yaml` the same way the code does: first the user config `data/config/schedule.yaml`, and only if it is absent the shipped default `config/schedule.yaml`:

| Key | Default | Meaning |
|---|---|---|
| `deploy.config_write_lock_stale_seconds` | 300 | Same-host locks check PID, process generation and held tokens; foreign hosts/namespaces can be taken over only after this age |
| `deploy.config_write_lock_wait_seconds` | 10 | Maximum wait for a writer lock before a busy error |
| `deploy.config_write_lock_retry_ms` | 50 | Initial retry delay, increased with backoff |
| `deploy.prune_build_cache` | true | Clean up the Docker build cache after deployment |
| `deploy.build_cache_keep_gb` | 5 | Keep this many GB of build cache by most recent use so the next build is still fast; 0 = remove all unused build cache |
| `deploy.prune_dangling_images` | true | Remove dangling images (untagged images left over from old builds) |
| `deploy.drain_timeout_seconds` | 900 | Step 8 waits at most this long for a running cycle to finish before the containers are recreated; 0 = do not wait |
| `deploy.drain_poll_seconds` | 10 | How often step 8 looks while it waits |
| `deploy.ai_worker_releases_keep` | 3 | Release directories of the ai-worker kept after a switch, the installed and the previous one included (at least 2). Not in the shipped file; add it to change it |
| `deploy.ai_worker_stop_timeout_seconds` | 60 | How long launchd / systemd waits after SIGTERM before it kills the ai-worker (`ExitTimeOut`, `TimeoutStopSec`); at least 10, keep it above `ai.yaml: host_worker.shutdown_grace_seconds`. Not in the shipped file |
| `deploy.ai_worker_swap_timeout_seconds` | 120 | The longest each wait of a worker switch may take (the old worker gone, the new one with evidence, the same on rollback); at least `ai_worker_stop_timeout_seconds` + 10. Also the step 11 wait cap (`--settle` overrides it). Not in the shipped file |

Step 11 returns as soon as it confirms the current service PID. No installed definition or
`JOB_RADAR_SERVICE_MANAGER=none` means there is nothing to wait for; an installed service with no reachable user manager
still times out. Another worker holding the same database's lock also prevents confirmation. The default 120 s is a
policy for common cases, not a guarantee: a degraded heartbeat loop followed by a database reconnect can take longer,
and a smaller configured cap can expire within one loop. A timeout means "could not confirm", not necessarily a broken
worker. A signal sent only to the deploy PID takes effect after the current bounded probe (or sleep) returns; no new
probe starts and the running probe is reaped before the wait ends.

### Build context and a clean checkout

The images are built from the commit being deployed, not from the working tree: step 6 unpacks `git archive` of that
commit into `data/build/<commit>-<pid>/` and builds from there. Files git ignores (`.env`, `data/`, a `*.local.yaml`),
untracked files, local edits, permission-only changes and symbolic links that point outside the repository never reach an
image. The shipped defaults in `config/` are part of the web and runner images (`/app/config`, read-only, owned by root);
nothing is mounted over them, so a change to `config/` reaches the containers only through a deploy.

Because the config steps and the migration run from the checkout itself, the checkout must match that commit: every mode,
`--skip-pull` included, refuses to start when a tracked file has uncommitted changes (`git status --porcelain
--untracked-files=no`; untracked files are allowed), and also when `git status` itself fails (for example a damaged
`.git/index`): a git that cannot answer never counts as a clean checkout. From step 2 on, the steps stop with `checkout
moved during deploy` if HEAD moves or a tracked file changes while the deploy runs, and with `cannot check the checkout`
if git fails at one of those checks.

The build context directory is removed when the deploy ends. If a deploy is killed outright (for example `kill -9`), the
directory stays; the next deploy removes it once it holds the lock.

### Settings freeze during deployment

Step 4 runs all read-only checks before creating or taking over the freeze. From then until `config-write` (step 11),
freeze-aware web versions refuse settings, advanced editor, profile and wizard saves with an upgrade message. On the
first deployment of this version, the older web runs until step 8; it still writes the old format, which is harmless.
Existing means YAML in either user directory, an existing freeze marker, an installed worker service, or running
compose services. A true first install is not frozen and skips the later config-write gate. Downgrading to a target without the freeze protocol uses its original step-4 `config:init` and `config:migrate --write`, skipping freeze and `config-write`; any leftover marker is kept and reported (see [upgrade.md](upgrade.md#downgrade-pre-config-freeze)). Startup fills skip missing files without throwing; missing profiles
read `config/profile.example/` in memory. Each user directory has a short cross-process `.write.lock`; all writers check
freshness and the marker inside it. Same-host locks check the PID, process generation (a random process ID and start time), and held tokens. A reused PID or abandoned token is recovered immediately; live owners remain busy. Foreign hosts/namespaces require an age over 300 seconds and wait up to 10 seconds (`deploy.config_write_lock_*`
in `schedule.yaml`). The `.upgrade-freeze` marker and `.write.lock` are excluded from backups.

Stop manually started old `pnpm ai-worker` processes before deploying. Both `--no-ai-worker` and `--settle 0` still check
the instance-lock holder, host processes and the installed service's release path, with the same service PID before and
after the checks. An old/unknown holder, another worker PID or a failed
`ps -A -o pid=,args=` scan keeps the freeze and returns 2; the message lists other worker PIDs. The scan matches node/tsx worker entries belonging to this install; relative entries use the process cwd (`lsof` on macOS, `/proc/<pid>/cwd` on Linux). Editors and workers of other checkouts are ignored; unknown ownership blocks writes. A failure or
interrupt before `up` starts new code automatically removes only a freeze this run created fresh, using `ops:unfreeze --owned`.
A freeze taken over from an earlier run stays until `config-write` excludes old consumers, or the user runs `ops:unfreeze`.
Once step 8 attempts `up`, a failure or interrupt keeps every marker. Deployment does not fill or migrate user files
before `config-write`, so their format stays readable by the old code; any saves from an older web still use that format.
Run deploy again; `pnpm run doctor` warns with `config.freeze` if a marker remains without an active deploy lock.
After confirming no old consumers remain, `pnpm ops:unfreeze` removes it under the write locks and prints
`pnpm config:init`, then `pnpm config:migrate --write`. `pnpm ops:freeze --target <commit>` creates/replaces it. Only explicitly authorized config
commands receive `JOB_RADAR_UPGRADE_FREEZE_TOKEN`; it is never printed or passed to services.

Restart unmanaged host processes (for example `pnpm mcp:serve`) after the upgrade. Recovery, rollback and older
`--skip-pull` scripts: [upgrade.md](upgrade.md#settings-during-an-upgrade).

### One deploy at a time: the deploy lock

Step 1 takes the lock `data/releases/ai-worker/.lock/` (a directory; `owner` names the process and host,
`inflight/` holds one record per script working under the lock). A second deploy started meanwhile stops in step 1 with
exit code 1, changes nothing and prints who holds the lock, the records, and how to check and clear it. The lock is
released just before the Docker cleanup (step 12), or when the deploy stops early. The release step and the ai-worker step run under the same lock (they re-enter it), and `install-ai-worker.sh` run by hand takes it too. If the lock cannot even be set up
(disk full, no write permission on `data/releases/`), step 1 stops with `could not initialise the deploy lock`, removes
what it created and blames no other deploy; if that removal fails too, the half-made lock stays and is reported like
any lock left in place (clear it as shown, then retry). If another deploy releases the lock at the very moment this one
tries to take it, step 1 says so; just run the script again. When releasing, the deploy names why it keeps a lock
(records left, a damaged owner file, unexpected entries); if the lock now belongs to another run, or is gone, it says so
and prints no clear command (never remove a lock another deploy holds).

A lock is never taken over automatically. It stays behind only when a deploy was killed with `kill -9` (its exit handler
could not run), or when the deploy could not confirm that everything it started has ended (then it exits 1 with
"descendant exit not confirmed; lock left in place"). Before you clear it, make sure nothing it started is still running,
with the `ps` command the message prints (a build, `pnpm install`, a migration, a config write, a drain), then remove the
lock with the `rm -rf data/releases/ai-worker/.lock` it prints, and deploy again.

### The ai-worker runs from a release directory

The ai-worker never runs from the checkout itself: a `git pull` or a branch switch would change its code under it. Each
deploy builds `data/releases/ai-worker/<commit>/` (step 7, `scripts/ops/prepare-release.sh`): the files of that commit and
its production dependencies, made read-only. The service definition (the plist, or the systemd unit) names only absolute
paths: the code and `config/` from the release; `.env`, `data/config`, `data/profile` and `data/logs` from the main
checkout.

Step 10 switches the worker with `scripts/ops/install-ai-worker.sh --release <dir>`. It first copies the installed
definition to `data/run/ai-worker-swap-backup/`, stops the old worker and waits until it is gone, writes and starts the new
definition, and waits up to `deploy.ai_worker_swap_timeout_seconds` for evidence from the new worker (a new process
holding the database lock and a heartbeat newer than the switch). Without evidence it puts the old definition back,
starts it and waits for its evidence the same way. The first line of the result says what happened:

- `installed: … runs <commit> from <dir>`: done. Older release directories beyond `deploy.ai_worker_releases_keep` are
  removed, and the backup with them.
- `not changed: …` (exit 1): refused before anything was touched (lock held, an unresolved backup, more than one worker
  definition, the database clock unreadable).
- `rolled back: …` (exit 1): the new worker gave no evidence; the previous one runs again. Read the reason and
  `data/logs/ai-worker.err.log`, fix it and deploy again.
- `ROLLBACK FAILED: …` (exit 1): the previous state could not be restored. The message says what is installed now; the
  backup stays in `data/run/ai-worker-swap-backup/` and the next install refuses until it is resolved (see
  [upgrade.md](upgrade.md#unresolved-switch-backup)).

`scripts/ops/install-ai-worker.sh --print-release` prints the release directory of the installed worker (exit 0), exits
3 when no worker is installed (or only under the old label `de.jobradar.ai-worker`), 4 when one is installed but not from a release directory (an install from before), and 1
when the definition cannot be read or there are several. Interrupted with Ctrl-C, TERM or HUP during a switch, the script
first rolls back, then exits 130, 143 or 129.

### Interrupting a deploy

Ctrl-C, closing the terminal and `kill <pid>` do not cut a step off halfway. Each command of a step runs in its own
process group, which the terminal's signals do not reach: the step that is running finishes first, no further step
starts, the lock is released and the build context removed, and the script exits with 130 (Ctrl-C, INT), 143 (TERM) or
129 (HUP, the terminal closed). It prints the step and its process group as it stops:

```text
stopping after this step (build: build the images from the target commit, process group 12345); to abort it now: kill -TERM -12345
```

To abort the running step at once, send that `kill -TERM -<group>` yourself: the step then fails, and the deploy still
waits for the group to empty before it cleans up and releases the lock. A deploy stopped this way leaves the system as
a failed step would (the steps already done are not rolled back); run the script again to finish.

When the terminal closes, a command that writes to it can fail and fail its step. Run a production deploy inside `tmux`
(or `nohup scripts/ops/deploy.sh > deploy.log 2>&1 &`) so that a dropped ssh connection does not stop it.

### Work interrupted by a restart

A deploy (or a crash, or `launchctl kickstart`) can restart the runner or the ai-worker while they are working. Nothing is dropped silently:

- **Control requests** (`run_ai`, scoring, translation, re-score, interest suggestions): a request the restart cuts off goes back to the queue as pending and runs again when the process is back. Scoring and pushing pick up where they stopped: jobs that already have a score are not scored again, and jobs already pushed are not pushed again. A request interrupted more than `ai.yaml: host_worker.requeue_interrupted_max` times (3) fails instead, so a request that brings the process down cannot loop forever; 0 restores the old behaviour (fail at once). The runner uses the same value. Two kinds are not queued again but fail, and you click them again if you still want them: the "Test" buttons, and a manual "collect now" (the catch-up below already re-runs the collection, a second one would only collect twice).
- **Cycles**: a running cycle cannot be resumed halfway, so step 8 waits for it first (above). If it is cut off anyway (wait timed out, `--no-drain`, a crash), the cycle is marked failed, and when the runner starts its catch-up does not count that cycle as having run: the scheduled slot it belonged to runs again straight away. Only once in a row: if that re-run is cut off as well (for example a cycle that crashes the runner), it counts as having run, so a crash cannot become a loop of full collections.

### Only one ai-worker

The ai-worker holds a Postgres session advisory lock for as long as it runs; a second one exits with code 3 (after `ai.yaml: host_worker.already_running_wait_seconds`, 60, unless `--once`), so a request is never run twice. Two limits:

- The lock needs a real session. If `DATABASE_URL` goes through a pooler in transaction mode (for example PgBouncer `pool_mode = transaction`), the lock is not tied to the worker's connection and does not protect anything: point the ai-worker at Postgres directly or at a session-mode pool. The compose setup connects directly.
- When the database restarts, every lock is gone. The worker takes it again on its next heartbeat (`host_worker.heartbeat_seconds`); a second worker that starts in that gap gets the lock instead, puts the first one's running request back into the queue (so it can run twice) and the first one shuts down at its next heartbeat. Only a second worker started by hand during a database restart can hit this.

Where the ai-worker installed in step 10 writes its logs:

- **Limitation**: launchd itself cannot open files on an external volume. If the plist's `StandardOutPath` / `StandardErrorPath` point to an external volume, the job does not start at all (`launchctl print` shows `last exit code = 78: EX_CONFIG`; same with `/bin/sh` and with node, verified on macOS). `WorkingDirectory` and program files on the external volume are fine, and a node process started by launchd can also write files to the external volume. So do **not** change those two plist paths to an external volume.
- The ai-worker writes its own output to `data/logs/ai-worker.out.log` / `ai-worker.err.log` (on the project's volume). When a file exceeds `ai.yaml: host_worker.log_max_mb` (10 MB) it is copied and truncated, keeping `log_keep` (3) copies `.1` to `.3`.
- launchd's own output file stays on the internal disk: `~/Library/Logs/job-radar/ai-worker.launchd.log`. It only catches output and crashes from before the worker opens its own log; it is rotated by size too, and the rotated old copies go to `data/logs/`, so the internal disk only ever holds this one small file.
- Versions installed before this arrangement also wrote logs to `~/Library/Logs/job-radar/ai-worker.{out,err}.log` (doctor's `aiworker.launchd` shows ⚠️ for it): re-run `scripts/ops/install-ai-worker.sh` (or `scripts/ops/deploy.sh`) and the old logs are moved once to `data/logs/ai-worker.{out,err}.before-upgrade.log`.

Exit codes: `0` deployment finished and doctor has no problems (or only ⚠️); `1` a step failed (the ai-worker switch included), or another deploy holds the lock, or doctor itself could not run; `2` deployment finished but doctor reported ❌, user config writes are pending, or step 11 could not confirm the ai-worker service working (follow the warnings and hints, then run `pnpm run doctor` again); `130`, `143`, `129` the deploy was interrupted (INT, TERM, HUP; see "Interrupting a deploy").

On the first deployment it is normal for doctor to show ⚠️ or ❌ (Tailscale not connected, the paid channels without a key; Telegram is reported as optional until you switch it on): complete the section 1 checklist until `pnpm run doctor` is all ✅. Then do a restart verification (host-setup section 5: quit and reopen Docker Desktop; the four services return to healthy within a minute or two), and ideally reboot the Mac once to confirm the whole system comes back with nobody touching it.

## 3. Daily check: `pnpm run doctor`

```bash
pnpm run doctor              # item by item, ✅ / ⚠️ / ❌, each ⚠️ and ❌ has a "what to do" underneath
pnpm run doctor --json       # the same content as JSON, for scripts
pnpm run doctor --only compose --only tailscale   # run only checks whose id starts with these prefixes
pnpm run doctor --lang en    # the report in another language (default: language.yaml cli.locale, see languages.md)
```

Note the spelling `pnpm run doctor`: plain `pnpm doctor` is a built-in pnpm command (it checks pnpm's own installation) and does not run this script.

**Read-only**: it sends no Telegram message, calls no AI, spends no money and changes nothing. claude / codex are only checked for login status (`claude auth status`, `codex login status`), and Telegram is only checked for a configured, well-formed token and chat id.

The exit code reflects the worst item: `0` all ✅, `1` some ⚠️, `2` some ❌, `3` doctor itself could not run (bad arguments, unreadable config). Each item's `id` is stable and can be looked up by id in `--json`.

### What each check covers

| id | Check | What ❌ / ⚠️ mean and the first step |
|---|---|---|
| `docker.daemon` | Docker is running | ❌ Docker Desktop is not up: `open -a Docker` |
| `compose.db` `compose.web` `compose.runner` `compose.jobspy` | The four services of compose project `job-radar` are running and healthy; ports are bound to 127.0.0.1 only | ❌ container stopped or unhealthy: view logs (`docker compose -p job-radar logs --tail 100 <service>`); a port bound to 0.0.0.0 is also ❌ (violates the localhost-only rule), unless `JOB_RADAR_WEB_BIND` opens the web on purpose **and** a web password is set (without one: ❌ with "set a password first"). The web published beyond loopback while `JOB_RADAR_WEB_BIND` is unset or a loopback address is ❌ too: the local login exemption is still on, so set `JOB_RADAR_WEB_BIND` to the published address. ⚠️: the service runs as a process on the host (UAT or `pnpm runner`) rather than as a compose container; it works, but will not come back by itself after a reboot |
| `compose.project` | The containers of the compose project were started from this checkout (`com.docker.compose.project.working_dir`) | ⚠️ another checkout runs containers under the same project name: they would take over each other's containers and share the database volume. Give the second instance its own names, see [multiple-instances.md](multiple-instances.md) |
| `web.http` | From the host, `doctor.web_url` `/api/health` returns 200 with the database ok | ❌ web is not up or cannot reach the database |
| `db.connect` | The host can connect to the database (`DATABASE_URL`; if unset it is assembled from `POSTGRES_*` and `DB_HOST_PORT` in `.env`) | ❌ db is not up, or the password in `.env` is wrong |
| `db.migrations` | Database migrations are up to date (compared against `drizzle/meta/_journal.json`) | ❌ migrations missing: `scripts/ops/deploy.sh` or `pnpm db:migrate`; ⚠️ the database is newer than the code: was the code rolled back? (see section 5) |
| `runner.heartbeat` | The runner's latest heartbeat is within `RUNNER_HEALTH_MAX_AGE_SECONDS` (default 120 seconds) | ❌ runner is stuck or stopped: check the logs, then `docker compose restart runner` |
| `aiworker.launchd` | `io.jobradar.ai-worker` is installed in launchd and running (on Linux: the systemd user unit `job-radar-ai-worker.service` is active, read with `systemctl --user show`) | ⚠️ only the old label `de.jobradar.ai-worker` is loaded: run `scripts/ops/install-ai-worker.sh` to migrate; ❌ not installed or not running: first look at `~/Library/Logs/job-radar/ai-worker.launchd.log` (start failures and crashes), then `scripts/ops/install-ai-worker.sh`; ⚠️ not installed in launchd but a heartbeat exists (started by hand); ⚠️ running but logs still go to the old location on the internal disk (installed by an older version): re-run `scripts/ops/install-ai-worker.sh` |
| `aiworker.heartbeat` | The ai-worker heartbeat is within `ai.yaml: host_worker.offline_after_seconds`; where the service PID can be checked, its receipt confirms the lock, heartbeat and its own config report | ❌ offline or never beat: see `data/logs/ai-worker.err.log`; for crashes see `~/Library/Logs/job-radar/ai-worker.launchd.log`. ⚠ current process not confirmed (normal for one heartbeat interval after a start or database reconnect; if persistent, check `ai-worker.out.log` for "could not report the shipped config"); ⚠ another process holds the lock: stop the other worker or the service, as appropriate. Receipt checks only downgrade ✅ to ⚠; an unavailable receipt leaves the existing result unchanged |
| `ai.claude` `ai.codex` | Both subscription CLIs are logged in | ⚠️ one is not logged in (the other still works); ❌ neither is, so AI scoring and translation stop: `/login` inside `claude`, `codex login` |
| `telegram.credentials` `telegram.enabled` | The token and chat id in `.env` are configured; `notify.yaml: telegram.enabled` is true | Telegram switched off and not configured: reported as optional (✅); ⚠️ credentials present but the switch is off; ❌ the switch is on but the credentials are missing, so no push messages |
| `network.public_url` | `notify.yaml: public_base_url` is set and reachable from this machine | ⚠️ not set (messages have no "open details" link); ❌ set but unreachable (it will not open on your phone either) |
| `tailscale.status` `tailscale.serve` | Tailscale is running; `tailscale serve` exposes the web port to the tailnet; Funnel is off | ⚠️ not connected or no serve rule; ❌ Funnel is on (the page is on the public internet): `tailscale serve reset` |
| `web.access` | The optional web password: set as a hash ✅; as plain text, or shorter than `ui.yaml: web_access.min_password_length` ⚠️; a hash that cannot be read ❌ (nobody can sign in); a hash with scrypt `N` below 16384 ⚠️ (run `pnpm web:password` again); a password set while the web runs outside compose and `JOB_RADAR_WEB_BIND` is unset ⚠️ (`http://localhost` needs the password too: set `JOB_RADAR_WEB_BIND=127.0.0.1`); no password ✅ while the web listens on loopback only and `tailscale serve` does not forward to it, ⚠️ otherwise | `pnpm web:password`, paste the line into `.env`, `docker compose up -d web` (see [configuration.md](configuration.md#web-access-optional-password-bind-address-and-port)) |
| `backup.recent` | The backup directory exists and the latest backup is within `backup.max_age_hours` (default 30) | ❌ directory missing or backup too old: see [backup-restore.md](backup-restore.md); ⚠️ no automatic backup in the directory yet (just deployed) |
| `data.ownership` | Linux only: everything under `data/` and `.auth/` belongs to the uid the containers run as (`PUID`, default 1000) | ⚠️ files owned by another user (left by an older version or a `sudo` command), the containers cannot write them: `sudo chown -R <PUID>:<PGID> data .auth`, see [upgrade.md](upgrade.md) |
| `data.traps` | AI traps: jobs with traps (all / last `scan.recent_days` days), jobs not scanned yet | ⚠️ backlog above `scan.backlog_warn`: `pnpm traps:scan --write`; ⚠️ `traps.yaml` unreadable / `enabled: false` / not migrated. See [ai-traps.md](ai-traps.md) |
| `data.mcp` | Whether the read-only MCP server is switched on (`mcp.yaml: enabled`) and which tools; off is the default | ⚠️ `mcp.yaml` unreadable: `pnpm config:check`. See [mcp.md](mcp.md) |
| `disk.backups` `disk.docker` | Free space on the volume holding backups and on the volume holding Docker data. `disk.docker` measures Docker Desktop's `DataFolder` setting (`~/Library/Group Containers/group.com.docker/settings-store.json`; if unreadable, the default location `~/Library/Containers/com.docker.docker/Data/vms/0/data`), and the detail states the path measured | ⚠️ below `warn_free_disk_gb` (20), ❌ below `min_free_disk_gb` (5). To clean up: `docker system df`, `docker builder prune`, old manual backups, `data/logs/` |
| `disk.docker_location` | Docker's data directory (`DataFolder`) is on the same volume as the project (compared by device number, not by a hard-coded volume name) | ⚠️ it is not: the database, images and build cache are all on the system disk. If your internal disk is small, move the Docker data directory to the external volume (see `doctor.storage_guide` if you configured one) |
| `disk.internal` | Free space on the Mac's system disk (`/System/Volumes/Data`) | ⚠️ below `internal_warn_free_disk_gb` (30), ❌ below `internal_min_free_disk_gb` (10): first confirm `disk.docker_location` is ✅, then clean up as needed |
| `channels.<id>` | Each **enabled** channel: missing key, circuit breaker, all failed in the last cycle, this month's budget and free quota (⚠️ at the first tier of `notify.yaml: alerts.budget_thresholds`, ❌ when used up) | ⚠️ usually a missing key or an open circuit breaker (affects only that channel, others are unaffected); the `/sources` page has details |
| `channels.linkedin` | At least one usable channel in the LinkedIn cascade, or none set up (LinkedIn is optional); a login-state file exists when `linkedin-session` is enabled | ❌ channels are set up but none can run (paused or not registered) |
| `budget.paid` `budget.ai_api` | This month's total for paid channels, and the estimate for paid AI APIs, vs. budget | ⚠️ threshold reached, ❌ used up |
| `cycle.last` | Status of the last cycle; whether a scheduled cycle was missed (not started within `doctor.cycle_grace_minutes`) | ❌ the last cycle failed or a cycle was missed: is the runner up, did the Mac sleep? |
| `cycle.next` | Time of the next cycle | ❌ all three cycles are turned off |
| `ai.profile` | `data/profile/me.yaml` has a summary or skills; only then does AI scoring start | ❌ both are empty and jobs are waiting to be scored; ⚠️ both are empty but nothing is waiting yet, or me.yaml cannot be read. What to do: open /me, fill in at least one and save; scoring starts on the next cycle. Until then the Today page and the top of /me show an "incomplete profile, AI scoring paused" banner |
| `config.guards` | The CLI commands in `ai.yaml` are `claude` / `codex`, `codex_cli.config_overrides` has only allowed keys, the services that receive a key point to the vendor's own host, `JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS` is not set | ❌ a `command` is refused (that CLI never runs); ⚠️ overrides ignored, a changed `base_url` / `api_base_url` refused or (with the opt-in) used, or the opt-in variable set. See [ai-providers.md](ai-providers.md#what-the-ai-worker-does-not-take-from-aiyaml) |
| `ai.backlog` | AI request queue, jobs waiting to be scored, result of the latest `run_ai` (if nothing was scored because the profile is incomplete, the reason is stated and it does not count as success) | ⚠️ backlog: is the ai-worker up? |
| `ai.quota` | Job Radar's own usage cap of the subscription CLIs (`ai.yaml: quota_guard`): each CLI's calls in the rolling window against `hard_requests`. Only Job Radar's own calls are counted, so this says nothing about what is left of your account's quota | ⚠️ a CLI's window is full, or the CLI reported a limit and is cooling down: it resumes by itself at the time shown; raise the cap in Settings → AI → Limits if it gets in your way (`pnpm ai:usage-stats` shows your own numbers) |
| `config.freeze` | No leftover upgrade freeze, or a freeze held by an active deploy; write leases and guard owners in `data/config/` and `data/profile/` are younger than the stale threshold | ⚠️ marker remains without an active deploy: deploy again, or confirm no old consumers and run `pnpm ops:unfreeze`, `pnpm config:init`, then `pnpm config:migrate --write`. Old write-lock owners: abandoned locks are taken over automatically on the next write; if saves keep failing, confirm the owner is no longer writing, then remove the lock file or guard owner |
| `config.layers` | The user config directory `data/config` exists and is writable; lists overridden `shipped` files, files whose version is behind (need migrating), and `user` files still read from the defaults | ❌ directory missing or not writable (`pnpm config:init`; check the mount); ❌ a file's `config_version` is newer than the code (the code was rolled back: upgrade the code or restore from `data/config/.backup/`); ⚠️ you overrode `models.yaml` / `pipeline.yaml`: product updates to those files will not take effect, delete your copy in `data/config` if you want to follow them; ⚠️ version behind: `pnpm config:migrate` shows the changes, `--write` writes them back |
| `config.shipped` | The shipped config identity each running process reports (web, runner, and the ai-worker with `execution: host`), and that each report comes from the process running now: the running container (host name and start time) or the ai-worker service's PID; the ai-worker's config comes from a release directory of this checkout whose commit is HEAD. See [configuration.md](configuration.md#shipped-config-identity) | ⚠️ the ai-worker runs from outside `data/releases/ai-worker/` (installed by a version from before release directories): deploy or run `scripts/ops/install-ai-worker.sh`; ⚠️ its release is not HEAD: expected after a worker-only rollback, otherwise a deploy stopped before step 10: deploy again; ⚠️ no report, a report from an earlier container or process, or no PID from launchd / systemd to match it: for containers just deployed or restarted, wait a minute and run again; for the ai-worker, check whether `aiworker.heartbeat` says its current process is not confirmed yet, and look for "could not report the shipped config" in `data/logs/ai-worker.out.log` if its report stays missing. ⚠️ something mounted on `/app/config` in a container (it hides the shipped config in the image; usually an old `compose.override.yaml`): remove the mount and deploy. Without the database the reports are skipped, the mount check still runs (it needs only Docker) |
| `host.power` | In `pmset`, autorestart is 1 and sleep is 0 | ⚠️ not set: host-setup section 3 |
| `ops.releases_lock` | No deploy lock `data/releases/ai-worker/.lock` is left behind. A lock held by the deploy that runs the doctor (same token in `JOB_RADAR_RELEASES_LOCK_TOKEN`) is ✅ | ⚠️ a lock exists: it shows the owner (pid, host, how long), each in-flight record and whether its process still runs, the `ps` command to find what a killed deploy left running, and the `rm -rf` to clear it (see "One deploy at a time" above). The token is never shown |
| `ops.ai_worker_swap_backup` | No unresolved worker switch backup `data/run/ai-worker-swap-backup/` | ⚠️ a switch failed and its rollback did not finish; the next install refuses until it is resolved: [upgrade.md](upgrade.md#unresolved-switch-backup) |

Doctor's thresholds and names are in `schedule.yaml` (the copy in the user config `data/config/`; no restart needed, changes apply on the next run):

| Key | Default | Meaning |
|---|---|---|
| `backup.max_age_hours` | 30 | Maximum age in hours of the latest backup |
| `doctor.compose_project` / `compose_services` | `job-radar` / db web runner jobspy | Which compose project and which services to check; `COMPOSE_PROJECT_NAME` in the environment or `.env` wins (a second instance) |
| `doctor.web_url` | `http://127.0.0.1:3000` | Address the host uses to reach the web page; override temporarily with the environment variable `JOB_RADAR_DOCTOR_WEB_URL`. When `JOB_RADAR_WEB_PORT` / `JOB_RADAR_WEB_BIND` are set, the doctor uses that port and address instead (`0.0.0.0` becomes `127.0.0.1`) |
| `doctor.probe_timeout_seconds` / `command_timeout_seconds` | 5 / 15 | Maximum wait for one HTTP request / one command |
| `doctor.min_free_disk_gb` / `warn_free_disk_gb` | 5 / 20 | Disk space thresholds (volume holding backups, volume holding Docker data) |
| `doctor.internal_min_free_disk_gb` / `internal_warn_free_disk_gb` | 10 / 30 | Thresholds for the Mac's system disk (`disk.internal`) |
| `doctor.storage_guide` | `docs/host-setup.md` | The guide that `disk.docker_location` points you to (a path or file name of your own, if you keep storage notes) |
| `ai.yaml: host_worker.disk_check_minutes` | 10 | How often the host ai-worker measures free space on the Docker data volume (the same volume as `disk.docker`, also located via `DataFolder`). The low-space banner on `/sources` uses this value and says where it came from; web runs in a container and measures the container's disk, which is only shown as a fallback when the ai-worker has not written for more than 3 intervals |
| `ai.yaml: host_worker.docker_data_path` | unset | Absolute path of the Docker data directory. The ai-worker uses it directly when measuring disk instead of reading the settings file under `~/Library/Group Containers/group.com.docker/` (under launchd, reading it can hang on a macOS privacy prompt, so the measurement times out and the low-space banner never updates). Run `pnpm run doctor` in a terminal; the hint under `disk.docker_location` gives the value to enter |
| `ai.yaml: host_worker.log_max_mb` / `log_keep` | 10 / 3 | Rotate the ai-worker logs (`data/logs/ai-worker.{out,err}.log` and launchd's `ai-worker.launchd.log`) after this many MB, and how many old copies to keep (`.1` is newest) |
| `doctor.ai_backlog_warn` / `ai_oldest_pending_warn_minutes` / `ai_unscored_warn` | 40 / 30 / 200 | AI backlog thresholds |
| `doctor.cycle_grace_minutes` | 90 | How late a scheduled cycle may be before it counts as missed |
| `doctor.ai_worker_launchd_label` | `io.jobradar.ai-worker` | launchd label |
| `doctor.shipped_report_skew_seconds` | 2 | `config.shipped`: how much earlier than the container's start (Docker's clock) a report (the database clock) may be written. Not in the shipped file; add it to change it |
| `doctor.linkedin_auth_dir` | `.auth` | Login-state directory (relative to the project directory) |

Database password: when you deploy with `scripts/ops/deploy.sh` (or run `pnpm config:init`) on a first install (no `POSTGRES_PASSWORD` in `.env` and no `jobradar-pg` volume yet), `pnpm config:init` writes a random one into `.env` (mode 0600; the value is not printed) before the database is created, instead of the well-known default. An existing database keeps the password it was created with, so nothing is changed there; to change it later, use `ALTER USER` inside the database and then update `.env`. Back up `.env` yourself: it is in no backup.

Other locations: the database connection uses `DATABASE_URL` (if unset it is assembled from `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `DB_HOST_PORT` in `.env`), and the backup directory uses `RUNNER_BACKUP_DIR` (default `data/backups`, so run it from the project directory).

## 4. Upgrade

The first upgrade from 2.0.1 or older to a version that builds the shipped config into the images takes three commands
of its own; see "Upgrading across the shipped config in the images" in [upgrade.md](upgrade.md).

```bash
scripts/ops/deploy.sh --dry-run     # take a look first
scripts/ops/deploy.sh --ref v2.0.0   # recommended for users: a release tag (see upgrade.md)
scripts/ops/deploy.sh               # or follow main:  pull latest main, back up, build, restart, migrate, restart ai-worker, prune Docker build cache, doctor
```

Before upgrading the script automatically takes a `jobradar-manual-…-pre-deploy.dump` backup (manual backups are never pruned automatically). During the upgrade web and runner restart for a few tens of seconds; restarting the runner while a cycle is running interrupts that cycle, and on the next start `catch_up` re-runs it. To avoid cycles, upgrade between them: morning cycle 07:00, evening cycle 17:00 (weekdays), weekend 09:00.

After upgrading run `pnpm run doctor` and confirm there are no new ❌.

### With layered config

- The live configuration is `data/config/` (not in git) and the web UI only writes there. `config/` holds the defaults shipped with the code; they are built into the web and runner images, so a change reaches the containers with the deploy that builds and restarts them (steps 6 and 8), not with a `git pull` alone. A changed default only affects files that are **not** in the user directory (`shipped` files such as `models.yaml` and `pipeline.yaml`, unless you overrode them). So the main checkout no longer becomes dirty because of a save in the web UI, and a deployment no longer refuses to pull for that reason.
- **Upgrading from a version before layered config**: preserve the old live config directory before switching code (see [upgrade.md](upgrade.md)). An existing install now defers missing-file fills from step 4 to `config-write`, after old consumers are excluded. Avoid settings saves during the upgrade.
- An upgrade that changes a config format previews it in step 4 and writes it in step 11 `config-write`, with originals in `data/config/.backup/<timestamp>/`. `pnpm config:migrate` shows the diff; writes stay frozen until old consumers are excluded.

## 5. Rollback

Before restoring config from `data/config/.backup/` or restoring a database backup, read the rollback notes in
[CHANGELOG.md](../CHANGELOG.md) for the version you are leaving.

**Rolling back past the release that made AI salary lookups reference-only (`salary.yaml` `config_version: 2`).** Older code does not hide comparisons containing AI figures.

- **(a) Preferred: recompute with the new code before switching.** If the benchmark is off, temporarily set
  `benchmark.enabled: true` in `salary.yaml`, run `pnpm salary:benchmark`, confirm that it prints a summary and exits
  with code 0, then restore the previous setting.
- **(b) Configuration (required):** Whether you set `salary.yaml`'s `config_version` back to the old code's current
  version or restore the original from `data/config/.backup/<timestamp>/`, confirm that `benchmark.include_ai_lookups`
  is absent or `false` **before the old code starts**. The backup may contain `true`. Otherwise, the old code can count
  older cached lookups again (where the latest cached result still predates the upgrade); upgrading again hides the
  comparison until it is recomputed.
- **(c) If you restore a database backup, or (a) did not succeed:** The `pre-deploy` backup contains the old benchmark
  table, so restoring it undoes (a). With the old code running and `benchmark.include_ai_lookups` absent or `false`,
  run `pnpm salary:benchmark` again (if the benchmark is off, temporarily enable it, recompute, then restore the
  previous setting). Until this recomputation, the old code may display comparisons containing AI figures.

A failure in (a) does not block rollback: follow (c) and accept the display window before that recomputation.

First decide where the problem is:

- **Code problem, database untouched** (this release has no new migration): just go back to the last good commit.
- **This upgrade brought a new migration** and the new version has already written data: migrations only go forward, and old code may fail on the new database (doctor's `db.migrations` will say "the database is newer than this code"). The database must be restored as well.

Roll back the code:

```bash
git log --oneline -10                      # find the last good commit
git switch --detach <commit>               # the pre-deploy backup's name contains a date you can compare
scripts/ops/deploy.sh --skip-pull          # deploy the current checkout (do not pull main again)
```

To return to the latest version afterwards: `git switch main`, then `scripts/ops/deploy.sh`.

Config: when rolling back to code from before layered config, the old code reads `config/` (as it was before the switch); changes made in the web UI after the switch exist only in `data/config/`, so copy them back to `config/` by hand if needed. When rolling back to a version before a migration, files in `data/config` that were migrated are "too new" for the old code (`config.layers` ❌): replace them with the originals from `data/config/.backup/<timestamp>/`.

If the new migration has already been applied you must also restore the database (this **overwrites the main database**; do it only in that case; see section 4 of [backup-restore.md](backup-restore.md)):

```bash
ls -lh data/backups | grep pre-deploy                    # the backup automatically taken before the upgrade
scripts/ops/restore.sh data/backups/<jobradar-manual-…-pre-deploy.dump> --target jobradar --yes
```

The restore first checks the backup in a temporary database, then stops web, runner and the ai-worker, keeps the old database under the name `jobradar_before_restore_<timestamp>` (so the restore can be undone) and gives the restored copy the main name, then starts them again. A `…-premigrate-<applied>-<shipped>.dump` taken by the runner before the migration is an equally good file to restore. Afterwards `pnpm run doctor` should be back to all ✅ (`db.migrations` will match the rolled-back code).

After a rollback, write in your log's incident section: when, why you rolled back, and which commit you returned to.

## 6. 7-day unattended acceptance

Goal: for 7 consecutive days after deployment, with no human intervention, the daily cycles, push messages, AI and backups all work. Keep your own acceptance log (for example `unattended-<date>.md`, named after the real start date) with an observation table and an incident section.

### Before you start

1. The whole section 1 checklist is ticked, `scripts/ops/deploy.sh` succeeded, and `pnpm run doctor` is all ✅ (at most ⚠️ items you explicitly accept and note in the log).
2. You did a restart verification (quit and reopen Docker Desktop; ideally reboot the Mac once).
3. In the log write: the start date and time, the deployed commit (`git rev-parse --short HEAD`), and doctor's output at the start.
4. For the next 7 days do **not** restart services by hand, trigger cycles by hand or change config, otherwise it is not "unattended". If you need to change config or upgrade, record it in the incident section and restart the count.

### Once a day (ideally after the 17:00 evening cycle and its pushes are done)

```bash
pnpm run doctor                                            # note the exit code and the ⚠️ ❌ items
docker compose exec -T db psql -U jobradar -d jobradar -x \
  -v day=$(TZ=Europe/Berlin date +%F) -v tz=Europe/Berlin <<'SQL'
select
  (select count(*) from cycles where kind <> 'manual' and status <> 'skipped' and (started_at at time zone :'tz')::date = :'day') as cycles,
  (select count(*) from cycles where kind <> 'manual' and status = 'succeeded' and (started_at at time zone :'tz')::date = :'day') as succeeded,
  (select count(*) from cycles where kind <> 'manual' and status = 'partial' and (started_at at time zone :'tz')::date = :'day') as partial,
  (select count(*) from cycles where kind <> 'manual' and status = 'failed' and (started_at at time zone :'tz')::date = :'day') as failed,
  (select count(*) from jobs where (first_seen_at at time zone :'tz')::date = :'day') as new_jobs,
  (select count(*) from notifications where kind = 'job' and sent_at is not null and (sent_at at time zone :'tz')::date = :'day') as pushed,
  (select count(*) from scores where score is not null and (scored_at at time zone :'tz')::date = :'day') as scored,
  (select count(*) from ai_usage where (at at time zone :'tz')::date = :'day') as ai_calls;
SQL
ls -lh data/backups | grep "jobradar-$(TZ=Europe/Berlin date +%Y%m%d)"       # today's backup
```

(`-U jobradar -d jobradar` are the defaults if you have not changed `.env`; if you changed `POSTGRES_USER` / `POSTGRES_DB`, use yours. These queries are read-only.)

Fill the result into that day's row in your log:

| Column | From | Normal is |
|---|---|---|
| Cycles | `cycles` | 2 on weekdays (07:00, 17:00), 1 on weekends (09:00); `catchup` re-runs count too |
| Success rate | `succeeded` / `cycles` (record `partial` separately; `failed` must be 0) | All succeeded, or partial where the cause is a single channel (channels are isolated from each other) |
| New jobs | `new_jobs` | Greater than 0 (the exact number depends on channels and market; fewer at weekends) |
| Pushes | `pushed`; then check how many messages your phone's Telegram actually received and whether the detail links open | Matches what arrived on the phone; pushes in quiet hours (22:00-07:00) are held until the morning |
| AI scores | `scored` (`ai_calls` for reference: subscription CLIs cost 0) | Greater than 0; doctor's `ai.backlog` has no ⚠️ |
| Backup | `ls` for a `.dump` from around 03:30 that day (non-zero size) | One exists, and doctor's `backup.recent` is ✅ |
| doctor | Exit code and the ids with ⚠️ ❌ | Exit code 0 or 1; no ❌ |
| Manual intervention | Did you do anything by hand that day | None |

### What counts as a pass

**A day passes** when: the cycle count matches expectations, there are no `failed` cycles, there were pushes and your phone received them, the AI score count is above 0, there is a backup for the day, doctor has no ❌, and there was no manual intervention.

**The 7-day acceptance passes** when every one of 7 consecutive days passes. If any day fails: write the cause and the fix in the incident section, then restart counting from day 1 once it is fixed (unless you decide that it was a one-off event that does not affect the conclusion).

Do a "power-loss drill" on day 3 or 4 (reboot the Mac and do nothing by hand) and record how long it takes until doctor is back to all ✅.

### At the end

At the end of your log write the conclusion: whether all 7 days passed consecutively, the incidents you met, any ⚠️ that persists in doctor and why, and what needs improving.
