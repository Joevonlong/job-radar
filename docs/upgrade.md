# Upgrading, rolling back and uninstalling

[English](upgrade.md) | [中文](upgrade.zh.md)

Job Radar runs from a git checkout. Releases are signed git tags `vX.Y.Z` (see the [changelog](../CHANGELOG.md)). If you
only use Job Radar, **stay on a release tag** and upgrade from tag to tag; `main` is the development branch and can change
between releases.

## Upgrade to a release

```bash
git status                                   # must be clean (your data/ and .env are ignored by git, that is fine)
scripts/ops/deploy.sh --ref v2.0.0 --dry-run # read what it would do, change nothing
scripts/ops/deploy.sh --ref v2.0.0           # the real thing
```

Replace `v2.0.0` with the release you want (`git fetch --tags && git tag --list 'v*'` lists them). Read the changelog
section of that release first: it says whether you have to do something.

`--ref` accepts a tag or a branch. The checkout ends up on that commit (for a tag, git calls this a detached HEAD, which is
expected). Without `--ref` the script follows `main`.

Deploy does not verify signatures by default. Pass `--verify` to run `git verify-tag` on the tag first and stop if it is
invalid. It uses the maintainer's public key shipped as [`signing-key.pub`](signing-key.pub) (an `allowed_signers` file;
its fingerprint is `SHA256:HHRRfExpbUjcK0/pdc5E1qf94ogkREVkt9+1VP58JQc`, also given in [SECURITY.md](../SECURITY.md)); a key list you set yourself with
`git config gpg.ssh.allowedSignersFile` wins. Releases are signed when a signing key was available, see
[RELEASING.md](../RELEASING.md). To check by hand:
`git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=docs/signing-key.pub tag -v v2.0.0`.

### What the deploy script does

In order, and it stops at the first failing step:

1. **Preflight**: takes the deploy lock (one deploy at a time), checks that git, docker, node and pnpm are installed and
   Docker is running, and refuses a checkout with uncommitted changes to tracked files (with `--skip-pull` too).
2. **Checkout**: fetches tags and branches, detects the target's config-freeze capability before checkout, and switches to `--ref` (a version from before release directories is refused
   before the checkout moves, see [below](#downgrade-pre-release-dir)). From here on the deploy uses exactly that commit.
3. **Install** the dependencies from the lockfile.
4. **Config**: creates `data/` folders. On an existing install, previews config migrations, validates the new schema in
   memory and checks compose config, then freezes settings writes without filling or migrating user files. A first
   install runs `config:init` without a freeze.
   A target without the freeze protocol uses its original `config:init` and `config:migrate --write` flow here.
5. **Backup**: if the database is running, takes a `pre-deploy` dump into `data/backups/` first. A failing backup stops the
   upgrade.
6. **Build** the images from a `git archive` of that commit: they contain exactly the committed files, the shipped
   defaults of `config/` included, and nothing else from your checkout.
7. **Release**: builds the ai-worker's release directory `data/releases/ai-worker/<commit>/` (that commit's files plus its
   production dependencies, read-only), so the worker never runs from a checkout that a later `git pull` changes.
8. **Drain and restart**: waits (bounded) for a running cycle to finish, then recreates the containers and waits until they
   are healthy.
9. **Migrate** the database (also done by the runner at start-up). A pending migration is preceded by its own `premigrate` backup; if that fails, nothing is migrated.
10. **ai-worker**: switches the host AI worker service (the launchd agent on macOS, the systemd user unit
    `job-radar-ai-worker.service` on Linux) to the release of step 7, and puts the previous one back if the new worker
    does not come up (without a systemd user manager nothing is installed and the script says so).
11. **Config-write**: confirms the target worker service PID with its lock, heartbeat and config report, then scans host
    processes and compares the instance-lock holder with that PID and host. Only that target service PID, or no holder
    and no installed service, plus a successful scan with no other worker process, allows `config:init` and
    `config:migrate --write`. Re-plans to detect skipped writes; removes the freeze once old consumers are excluded.
    Skipped when no freeze token was taken (first install), or for targets without the freeze protocol.
12. **Prune**: releases the deploy lock, then cleans the Docker build cache and dangling images (never volumes).
13. **Doctor**: `pnpm run doctor` reports what needs attention.

Ctrl-C or a closed terminal lets the running step finish and then stops (exit code 130, 143 or 129); run the script
again to complete the upgrade. Details: [deploy.md](deploy.md), "Interrupting a deploy".

Details and options: [deploy.md](deploy.md).

### Settings during an upgrade

Step 4 finishes the read-only checks before creating or taking over the freeze. From then through `config-write`
(step 11), freeze-aware web versions refuse settings, advanced editor, profile and wizard saves. On the first deploy
of this version, the older web keeps running until step 8; its saves still use the old format and are harmless.
Existing means YAML in `data/config/` or `data/profile/`, an existing freeze marker, an installed ai-worker service,
or running compose services. A true first install is not frozen and skips the config-write gate. Startup fills skip missing files while frozen;
missing profiles read `config/profile.example/` in memory, without creating files.
Existing-install defaults, such as the language, are selected at read time until `config-write` creates their files.

The marker `data/config/.upgrade-freeze` holds a random token, target commit and start time. Only deployment commands
explicitly given the matching `JOB_RADAR_UPGRADE_FREEZE_TOKEN` can write through it; the token is never printed or given
to the web, runner or worker. All config/profile writers use short cross-process `.write.lock` files, config before
profile for multi-file writes. Freshness and freeze checks run inside the lock. Same-host owners carry a process generation
(random process ID and start time) as well as host/PID. A reused PID or a token no longer held by this process is recovered
immediately; a live owner stays busy. Foreign hosts/namespaces require an age over 300 seconds. Writers wait at most
10 seconds before a busy error (settings: `schedule.yaml` `deploy.config_write_lock_*`), and the final commit is fenced
against a replaced lease.

Stop manually started old `pnpm ai-worker` processes before deploying. An old or unknown instance-lock holder, an
unreachable database, or a service outside the target release defers config writes, keeps the freeze and returns exit 2.
An absent lock holder alone is insufficient: a manual worker whose database connection dropped can still run and later
reacquire it. On macOS and Linux, deploy runs `ps -A -o pid=,args=` and matches node/tsx executing the `src/ai-worker/index.ts` entry point
under this install, including its release directories. Relative entries use the process cwd (`lsof -a -d cwd -p PID -Fn`
on macOS, `/proc/PID/cwd` on Linux). Editors and other checkouts are ignored; unknown ownership blocks writes.
Any such worker PID other than the confirmed target service PID blocks writes; the message lists those PIDs.
A failed scan also blocks writes. `--holder --pid <expected> --host <host>` compares the
worker's published application name, including its 63-byte truncation, without trying to recover a truncated host.
`--no-ai-worker` still checks the holder, host processes and the installed service's release; it only permits that target
service PID, or no holder and no installed service, with no other worker process. `--settle 0` uses the same checks,
without a receipt wait: the service must point at the target release, its PID must hold the instance lock and stay
unchanged before/after the probe, and the process scan must exclude other workers. A write failure or a fresh migration plan with pending files also returns 2; once old consumers are
excluded the marker is removed even if writes need a manual retry.

Before step 8 attempts `up`, a failure or INT/TERM/HUP removes only a freeze this run created fresh, using
`ops:unfreeze --owned` and its token. A taken-over marker is kept even before `up`: only `config-write` after the consumer
checks pass, or the user's `pnpm ops:unfreeze`, removes it. From `up` on, failures and interrupts keep every marker. Deployment does not fill or
migrate user files before `config-write`; their format remains compatible with the old code, including saves by an older web.
Deploy again to resume. `pnpm run doctor` warns with `config.freeze` when a marker is left without an active deploy,
or a write lease/guard owner in `data/config/` or `data/profile/` exceeds the stale threshold. Abandoned locks are taken
over automatically on the next write; if saves keep failing, confirm the owner is no longer writing, then remove the
reported lock file or guard owner.
For manual recovery, first confirm no old consumers remain, then run:

```bash
pnpm ops:unfreeze
pnpm config:init
pnpm config:migrate --write
```

`pnpm ops:freeze --target <commit>` creates or replaces the marker under the same write locks; `pnpm ops:unfreeze`
removes it under those locks and prints `pnpm config:init`, then `pnpm config:migrate --write`. Backups exclude both the marker and `.write.lock`.
`pnpm config:migrate --json` gives read-only pending/problem counts for automation.

Restart host processes that deploy cannot manage, such as `pnpm mcp:serve`, after upgrading. Rolling code back after
successful config writes still requires compatible originals from `data/config/.backup/`. When `--skip-pull` runs an
older deploy script that does not understand the freeze, the marker may remain: old code ignores it and the next
upgrade with the new script takes it over. This does not make newer config files readable by old code.

### Linux: upgrading from a version whose containers ran as root

The web, runner and jobspy containers now run as an ordinary user, `PUID:PGID` from `.env` (default `1000:1000`), not as
root. Files an older version wrote into `data/` and `.auth/` may belong to root, and the containers can no longer write
them. Once, before the upgrade (from the project directory):

```bash
id -u; id -g                                  # your ids
# put them into .env:  PUID=<id -u>  PGID=<id -g>
sudo chown -R "$(id -u):$(id -g)" data .auth  # .auth only exists after a LinkedIn sign-in
```

Then upgrade as above. `pnpm run doctor` checks this afterwards (`data.ownership`: it warns about anything under `data/`
or `.auth/` that does not belong to `PUID`). macOS is not affected (Docker Desktop maps the ownership).

### Upgrading across the shipped config in the images

From the first release after 2.0.1 on (its changelog section has an upgrade note about this), the shipped defaults
(`config/`) are built into the web and runner images instead of being mounted from the checkout, and
`scripts/ops/deploy.sh` builds the images from a `git archive` of the commit it deploys. The first upgrade from 2.0.1 or
older takes three commands, in the project directory:

```bash
docker compose -p job-radar stop web runner
git pull                                # or, for a release: git fetch --tags && git checkout --detach <tag>
scripts/ops/deploy.sh --skip-pull
```

`job-radar` is the default compose project; if your `.env` sets `COMPOSE_PROJECT_NAME`, use that name.

Why the extra steps: the old containers read `config/` straight from the checkout through a mount. Updating the checkout
while they run would hand them the new defaults while they still run the old code (the same window every upgrade had
until now); stopping web and runner first closes it. The new `deploy.sh` then builds images with the config inside and
recreates the containers without the mount. Running only `docker compose up -d` is not enough: it does not rebuild
existing images, and the old images do not carry the shipped config (the old runner image has none; the old web image
has only an incomplete copy, a side effect of how the web app is bundled), so the new compose file (without the mount)
would start them without complete shipped defaults; it would also skip the config steps and the migration. Web and runner stay stopped from
the first command until step 8 of the deploy (a few minutes, mostly the build); a collection cycle due in that time is
caught up when the runner starts.

Later upgrades need nothing extra. If `pnpm run doctor` warns (`config.shipped`) that something is mounted over
`/app/config`, a compose file of your own (for example `compose.override.yaml`) still mounts `./config`: remove that
mount and deploy again.

<a id="first-upgrade-release-dir"></a>

### Upgrading to the ai-worker release directories

From the release whose changelog section has an upgrade note about release directories on, the host ai-worker no longer
runs from the checkout but from `data/releases/ai-worker/<commit>/`, which the deploy builds (see
[deploy.md](deploy.md), "The ai-worker runs from a release directory"). The first upgrade from an older version (this one
may also be the same upgrade as the one above) stops the worker until the deploy has installed it again; it may send one
"ai-worker offline" alert, and web and the scheduled cycles stop from step 3 until the deploy has finished. In the
project directory:

1. Remove the old worker: `scripts/ops/uninstall-ai-worker.sh`. The uninstall script of older versions knows only the
   labels `io.jobradar.ai-worker` and `de.jobradar.ai-worker`; if you set your own `doctor.ai_worker_launchd_label`, also
   run `launchctl bootout gui/$(id -u)/<label>` and delete `~/Library/LaunchAgents/<label>.plist`.
2. **Check that it stopped**, and do not go on until it has:
   - macOS: `launchctl print gui/$(id -u)/<label>` says the service is not found, and `pgrep -f src/ai-worker/index.ts`
     prints nothing;
   - Linux: `systemctl --user is-active job-radar-ai-worker` is not `active`, and `pgrep -f src/ai-worker/index.ts`
     prints nothing.
3. `docker compose -p job-radar stop web runner` (skip it and the old containers read the new `config/`).
4. Update the code: `git pull`, or for a release `git fetch --tags && git checkout --detach <tag>`.
5. Run the new `scripts/ops/deploy.sh --skip-pull`.

If the deploy stops before step 10, the worker stays stopped: fix the cause and run step 5 again. A switch that ends in
`rolled back:` leaves nothing installed here (there was nothing before): read the reason, fix it, deploy again.

## Roll back

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

Go back to the previous tag:

```bash
scripts/ops/deploy.sh --ref <previous tag>
```

This returns the code. `deploy.sh --ref` refuses a tag from before the ai-worker release directories (it says so before
the checkout moves); going back that far takes the manual steps in
[Downgrade to a version before release directories](#downgrade-pre-release-dir). If the release you are leaving applied a database migration, the older code may not understand the
newer database; then also restore the `pre-deploy` backup the upgrade took (this overwrites the database):

```bash
ls -lh data/backups | grep pre-deploy
scripts/ops/restore.sh data/backups/<the pre-deploy dump> --target jobradar --yes
```

The restore keeps the database it replaces as `jobradar_before_restore_<timestamp>`, so it can be undone; [backup-restore.md](backup-restore.md) (section 4) has the commands. A `premigrate` dump taken by the runner right before the migration works as well.

If the release you are leaving migrated a config file, the older code finds it "too new" (`pnpm run doctor` shows
`config.layers`): copy the original back from `data/config/.backup/<timestamp>/` into `data/config/`.
This also covers the `deploy.config_write_lock_*` keys in `schedule.yaml` written by `config:init`: older versions
reject these unknown keys even without a config-version change. Restore the compatible `schedule.yaml` backup before
starting the old code.

More in [deploy.md](deploy.md) (section 5) and [backup-restore.md](backup-restore.md). To follow `main` again:
`git switch main && scripts/ops/deploy.sh`.

<a id="downgrade-pre-config-freeze"></a>

### Downgrade to a release without configuration freezing

Before `--ref` moves the checkout, the running script checks the target's `# capability: config-freeze` marker in
`scripts/ops/deploy.sh`. A target without it uses the older step-4 behavior: `config:init`, `config:migrate --write`,
then `config:check`. It skips freeze creation and the later `config-write` gate, so it does not call commands the old
release lacks. Any leftover `.upgrade-freeze` marker is kept unchanged and reported: old code ignores it, and the next
upgrade with the protocol takes it over. Running the old script with `--skip-pull` likewise leaves the marker alone.
Restore compatible config originals before starting old code; the marker cannot make a newer format readable.

**Rolling back only the ai-worker** (an emergency, for example when a new worker misbehaves and the rest is fine): the
previous release directories are kept (`deploy.ai_worker_releases_keep`), so

```bash
ls data/releases/ai-worker/
scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<previous commit>
```

switches back within a minute. **The old worker code then runs on the database the new version may already have
migrated**; if that migration is not backward compatible, roll back the whole deploy instead. `pnpm run doctor` reports
`config.shipped` with "the checkout is at …" until the next deploy, which is expected. If that release directory is gone,
`scripts/ops/prepare-release.sh <commit>` builds it again.

<a id="downgrade-pre-release-dir"></a>

### Downgrade to a version before release directories

Versions before the ai-worker release directories install the worker from the checkout, and `deploy.sh --ref` refuses
them. By hand, in the project directory:

1. Remove the worker with the **current** `scripts/ops/uninstall-ai-worker.sh` (it also removes a worker under your own
   label; if it says the definition is ambiguous, follow the commands it prints) and check that it stopped, as in step 2
   of [Upgrading to the ai-worker release directories](#first-upgrade-release-dir). While the release lock
   `data/releases/ai-worker/.lock` exists (a deploy or an install is running, or a killed one left it) it refuses and
   changes nothing; it prints the lock's owner and how to clear a stale lock.
2. Delete the keys `deploy.ai_worker_releases_keep`, `deploy.ai_worker_stop_timeout_seconds`,
   `deploy.ai_worker_swap_timeout_seconds` and `doctor.shipped_report_skew_seconds` from `data/config/schedule.yaml` if
   you added them: the older version does not know them and refuses the file.
3. Optional, and only now, while the current tools are still there: remove the release directories. Their directories
   are read-only and their files may be shared with the pnpm store, so only the directories get write permission back,
   each path is checked first, and nothing follows a symbolic link:

   ```bash
   source scripts/ops/lib/releases.sh
   for d in data/releases/ai-worker/* data/releases/ai-worker/.tmp-* data/releases/ai-worker/.trash-*; do
     [[ -e "$d" ]] && release_rm "$PWD" "$PWD/$d"
   done
   rmdir data/releases/ai-worker data/releases   # only removes empty directories
   ```

   If `data/releases/ai-worker/.lock` exists, a deploy or an install is still running (or was killed): stop and check
   first (see [deploy.md](deploy.md), "One deploy at a time"). Already on the older version (no `releases.sh`)? Do the same
   by hand for each directory named like a commit, `.tmp-*` or `.trash-*` that is not a symbolic link:
   `find -P <dir> -type d -exec chmod u+w {} +`, then `rm -rf -- <dir>`. Never `chmod -R` (it would change files shared
   with the pnpm store).
4. `git fetch --tags && git checkout --detach <older tag>`.
5. Run the **older** `scripts/ops/deploy.sh --skip-pull`: it rebuilds the images and installs the worker from the
   checkout, as that version did.
6. Database: if the newer version migrated it, restore the `pre-deploy` backup as described above.

<a id="unresolved-switch-backup"></a>

### Unresolved switch backup

`scripts/ops/install-ai-worker.sh` copies the installed worker definition to `data/run/ai-worker-swap-backup/` before it
switches, and deletes the copy when the switch, or its rollback, has finished. If the copy is still there, a switch ended
with `ROLLBACK FAILED:` (or the script was killed): every later install refuses with `not changed:` and
`pnpm run doctor` warns (`ops.ai_worker_swap_backup`) until you resolve it.

1. Read the `ROLLBACK FAILED:` message (or `data/run/ai-worker-swap-backup/state`: `found_label` and `found_definition` name
   the definition that was installed before).
2. Stop every ai-worker: `launchctl bootout gui/$(id -u)/<label>` on macOS, `systemctl --user stop job-radar-ai-worker`
   on Linux, until `pgrep -fl src/ai-worker/index.ts` prints nothing.
3. Either put the saved definition back where `found_definition` says and start it (`launchctl bootstrap gui/$(id -u) <plist>`,
   or `systemctl --user daemon-reload && systemctl --user enable --now job-radar-ai-worker`), or install a release again
   in the next step.
4. Remove the backup: `rm -rf data/run/ai-worker-swap-backup`.
5. `scripts/ops/deploy.sh --skip-pull` (or `scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<commit>`)
   and check with `pnpm run doctor`.

## Uninstall

This removes Job Radar from the machine. **It is irreversible: the database, your profile, your configuration and your
logins are deleted. Make a last backup and copy it somewhere else first** (`scripts/ops/backup.sh`, then copy
`data/backups/`; also keep `data/profile/` and `data/config/` if you may come back).

Run these from the project directory:

```bash
# 1. the host AI worker (macOS launchd agent or Linux systemd user unit); --purge-logs also removes its logs
scripts/ops/uninstall-ai-worker.sh --purge-logs

# 2. stop and remove the containers and the network
docker compose -p job-radar down

# 3. delete the database volume (all stored jobs, applications and AI results) - cannot be undone
docker volume rm jobradar-pg

# 4. delete local data, secrets and logs
rm -rf data .auth .env
rm -rf ~/Library/Logs/job-radar          # macOS: launchd capture logs, if still present (on Linux the unit's output is in the journal)

# 5. finally the checkout itself
cd .. && rm -rf job-radar
```

If you changed the compose project name (`doctor.compose_project` in `schedule.yaml`), use that name instead of
`job-radar`. Optional: `docker image prune` removes the built images. If you set up Docker at login, power settings or
Tailscale for this project ([host-setup.md](host-setup.md)), undo those by hand; the CLI logins of `claude` / `codex` are
yours and stay.
