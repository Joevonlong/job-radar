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

1. **Preflight**: git, docker, node and pnpm are installed and Docker is running.
2. **Checkout**: fetches tags and branches and switches to `--ref` (it refuses to run on a dirty checkout).
3. **Install** the dependencies from the lockfile.
4. **Config**: creates `data/` folders, copies config files you do not have yet, and migrates config files whose format
   changed (originals are kept in `data/config/.backup/`).
5. **Backup**: if the database is running, takes a `pre-deploy` dump into `data/backups/` first. A failing backup stops the
   upgrade.
6. **Build** the images.
7. **Drain and restart**: waits (bounded) for a running cycle to finish, then recreates the containers and waits until they
   are healthy.
8. **Prune** the Docker build cache and dangling images (never volumes).
9. **Migrate** the database (also done by the runner at start-up). A pending migration is preceded by its own `premigrate` backup; if that fails, nothing is migrated.
10. **ai-worker**: reinstalls or restarts the host AI worker service: the launchd agent on macOS, the systemd user unit `job-radar-ai-worker.service` on Linux (without a systemd user manager nothing is installed and the script says so).
11. **Doctor**: `pnpm run doctor` reports what needs attention.

Details and options: [deploy.md](deploy.md).

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

## Roll back

Go back to the previous tag:

```bash
scripts/ops/deploy.sh --ref <previous tag>
```

This returns the code. If the release you are leaving applied a database migration, the older code may not understand the
newer database; then also restore the `pre-deploy` backup the upgrade took (this overwrites the database):

```bash
ls -lh data/backups | grep pre-deploy
scripts/ops/restore.sh data/backups/<the pre-deploy dump> --target jobradar --yes
```

The restore keeps the database it replaces as `jobradar_before_restore_<timestamp>`, so it can be undone; [backup-restore.md](backup-restore.md) (section 4) has the commands. A `premigrate` dump taken by the runner right before the migration works as well.

If the release you are leaving migrated a config file, the older code finds it "too new" (`pnpm run doctor` shows
`config.layers`): copy the original back from `data/config/.backup/<timestamp>/` into `data/config/`.

More in [deploy.md](deploy.md) (section 5) and [backup-restore.md](backup-restore.md). To follow `main` again:
`git switch main && scripts/ops/deploy.sh`.

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
