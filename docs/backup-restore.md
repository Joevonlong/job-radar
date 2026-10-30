# Backup and restore

The database lives in the Docker named volume `jobradar-pg` (inside Docker Desktop's disk image; wherever Docker's data directory is, that image is not an ordinary file and cannot replace a backup). The pg_dump files in `data/backups/` are its regular copy. This directory is inside your project; if you want off-machine protection, include it in your own backup routine.

Convention: steps marked **[You do this]** need you to confirm or perform them personally; the other commands can be copied and run directly. Commands run in the project directory (the one that contains `package.json`, `compose.yaml`, `config/` and `data/`) by default.

## 1. Automatic backup

Once a day the runner runs `pg_dump` according to the `backup` section of `schedule.yaml` (the copy in the user config `data/config/`); the runner image ships `postgresql-client-17`, the same version as `postgres:17`:

```yaml
backup:
  enabled: true
  cron: "30 3 * * *"     # 5-field cron, interpreted in the timezone at the top of the file
  keep_daily: 14          # the newest backup of each day, for the last 14 days
  keep_weekly: 8          # plus the newest backup of each ISO week, for the last 8 weeks
  timeout_minutes: 30     # pg_dump is aborted on timeout and counted as a failure
  config_archive: true    # also archive data/config and data/profile next to each dump (section 1, "Configuration")
  pre_migrate: true       # take a backup before a database migration changes anything (section 1, "Before a migration")
  keep_system: 5          # how many safety backups (premigrate, pre-restore, pre-deploy) of each kind to keep
  keep_old_databases: 1   # how many databases replaced by a restore to keep (section 4)
```

- File: `data/backups/jobradar-YYYYMMDD-HHMMSS.dump`, with the wall-clock time of `timezone`. `scripts/ops/backup.sh` and `restore.sh` use the same zone, which needs the system's time zone data (the `tzdata` package; every normal server image has it). Without it `backup.sh` asks the database container for the time instead of silently writing UTC, and `restore.sh` warns and orders backups by file modification time, so `--latest` stays right. The format is pg_dump custom format (already compressed), restored with `pg_restore`, and you can restore only some tables.
- It is first written (owner-only permissions, `0600`) as a `.partial` file. It is renamed only after pg_dump exited successfully, every byte was written without error, the file was flushed to disk and `pg_restore --list` could read its whole table of contents, so every `.dump` file in the backup directory is complete. A write error (for example a full disk) fails the backup and removes the temporary file. The retention policy runs only after a backup passed all checks, so a failed run never costs you an older backup.
- Retention (only `jobradar-YYYYMMDD-HHMMSS.dump` files are handled; other files are left alone): the newest backup of each day is kept for the last `keep_daily` days, the newest backup of each week for the last `keep_weekly` weeks, the union of the two is kept and everything else is deleted. Days and weeks are counted as "days/weeks that have a backup", so a runner that is down for a month does not wipe the history.
- **Configuration**: with `config_archive: true` (the default) every daily backup is followed by a same-named `jobradar-YYYYMMDD-HHMMSS.config.tgz`: your user config `data/config/` (without its `.backup/` folder and without `.web-session-secret`, the sign-in key, which is generated again when missing) and your profile `data/profile/`. They are not in the database and not in git. The archive is written after the dump (owner-only `0600`, read back and checked before it is accepted). If it cannot be written the dump is still kept and you get a warning (an `alert.backup_failed` notification with `key: config_archive`, and a doctor warning while the newest dump has no archive). Retention removes the archive together with its dump. `.env` (your secrets) and `.auth/` (the LinkedIn login) are **not** in any backup: keep your own copy. The archive does contain `sources.yaml`, whose `jobspy.proxies` can hold **proxy credentials** (`user:password@host`), so treat a `.config.tgz` like a secret: do not copy it off the machine unencrypted (use an encrypted destination, or `age`/`gpg` it first).
- **Before a migration**: when the runner or `pnpm db:migrate` finds that a database migration is pending, it first takes a safety backup `jobradar-manual-YYYYMMDD-HHMMSS-premigrate-<applied>-<shipped>.dump` (with its `.config.tgz`) and migrates only if that succeeded. If the backup fails the migration is not run and the runner stops with the reason, so a bad upgrade can always be undone from a dump taken just before it. A database that is already up to date, and a first install without data, are not backed up. `pre_migrate: false` turns it off (not recommended).
- **Safety backups are pruned, manual ones are not**: backups whose label starts with `premigrate`, `pre-restore` or `pre-deploy` are kept by `keep_system` per kind (the newest 5 by default) and the oldest are deleted after a successful daily backup. Every other manual backup (`scripts/ops/backup.sh`, with or without a label) is never deleted automatically. Note that this goes by the label: a manual backup you name with `--label pre-deploy-…`, `--label pre-restore-…` or `--label premigrate-…` is treated as a system backup and pruned too, so do not use those prefixes for backups you want to keep.
- After you save `schedule.yaml` it takes effect in about 5 seconds (hot reload). `enabled: false` turns automatic backup off.
- If, when the runner starts, it has missed the latest backup time (for example the host was off at 03:30) and `catch_up: true`, it takes one immediately.

### Confirm it is working

```bash
ls -lh data/backups
docker compose logs runner | grep -i backup
```

The log should contain `next backup: ...` and, each time, `backup finished` (with file name, byte count and how many old backups were deleted).

### When a backup fails

On failure the runner:
1. logs `backup failed` with a reason code (`pg_dump_failed`, `timeout`, `invalid_output`, `io`, ...);
2. writes an unsent `alert.backup_failed` record to the `notifications` table. With Telegram pushes enabled it is sent to you; otherwise look at it with this command:

```bash
docker compose exec db psql -U jobradar -d jobradar -c "select id, payload_json from notifications where kind = 'alert.backup_failed' and sent_at is null order by id"
```

Common causes: disk full (`df -h <your data volume>`), external volume not mounted (`ls /Volumes`), no permission on the `data/backups` directory (see section 1 of [host-setup.md](host-setup.md)), the db container is not up (`docker compose ps`). After fixing it, take one by hand: `scripts/ops/backup.sh`.

## 2. Manual backup

Before anything risky (upgrade, hand-editing the database, restore) take a backup first:

```bash
scripts/ops/backup.sh                    # data/backups/jobradar-manual-YYYYMMDD-HHMMSS.dump
scripts/ops/backup.sh --label before-x   # with a label in the name: ...-before-x.dump
```

The script needs only Docker (pg_dump runs inside the db container, so you do not need Postgres on the host). Before
renaming the `.partial` file it checks the archive's table of contents with the same container's `pg_restore --list`,
then calls the host's `sync` to flush it to disk. A failed dump, unreadable archive or failed flush removes the partial
file and stops the backup (and a deployment waiting for it). This check does not replace a full restore drill.
Manual backups are named `manual` and are **never pruned by the automatic retention policy**; delete them yourself when you no longer need them.

The configuration is kept as well: `scripts/ops/backup.sh` writes a same-named `….config.tgz` next to the `.dump`, containing the user config directory `data/config/` (without `.backup/` and `.web-session-secret`) and the profile `data/profile/`. They are not in the database and not in git, so this is one of the only copies of them. The runner's daily backup writes the same archive (see section 1).

```bash
tar -tzf data/backups/jobradar-manual-20261009-120000.config.tgz   # see what is inside
```

## 3. Restore drill (recommended monthly)

By default the restore goes into a new temporary database and does not touch the main one, and prints each table's row count side by side with the live database:

```bash
scripts/ops/restore.sh data/backups/jobradar-20261007-033000.dump
scripts/ops/restore.sh --latest                         # use the newest backup in data/backups
scripts/ops/restore.sh --list                           # show all backups, newest first, with their age
```

`--latest` compares the date and time in the file names, so it finds the newest backup whether it is a scheduled one (`jobradar-YYYYMMDD-HHMMSS.dump`) or a manual one (`jobradar-manual-YYYYMMDD-HHMMSS[-label].dump`). It prints the file it chose and how old it is. If that backup is older than `backup.max_age_hours` of `schedule.yaml` (or `--max-age-hours N`), the script prints a warning and asks you to confirm; without a terminal it refuses unless you pass `--yes` (the warning is still printed).

Example output:

```
== restoring jobradar-20261007-033000.dump into 'jobradar_restore_20261007033500'
== row counts (restored 'jobradar_restore_20261007033500' vs live 'jobradar')
table                                      restored       live
public.jobs                                    1234       1250
...
restored: 19 tables, 5678 rows
live:     19 tables, 5702 rows (it may have moved on since the backup was taken)
```

- The number of tables should match; row counts should be slightly lower than the live database (new data arrived after the backup). If a table shows `-` in the `live` column, the live database does not have that table yet (for example the backup came from a newer version). A `-` in the `restored` column is the opposite: the table is newer than the backup (the backup came from an older version), so it did not exist when the backup was taken; the migrations create it when the runner starts.
- The temporary database is kept by default so you can inspect it: `docker compose exec db psql -U jobradar -d <temporary database name>` (the script prints the full command and the delete command at the end). Delete it when you are done:

```bash
docker compose exec db psql -U jobradar -d postgres -c 'drop database "jobradar_restore_20261007033500"'
```

Or add `--drop` during the drill so it is deleted automatically after verification: `scripts/ops/restore.sh --latest --drop`.

## 4. Actually restoring the main database  **[You do this]**

Do this only when the main database is broken, was altered by mistake, or you need to roll back to a point in time. The script requires you to spell out the database name and `--yes`:

```bash
scripts/ops/restore.sh data/backups/jobradar-20261007-033000.dump --target jobradar --yes
scripts/ops/restore.sh --latest --target jobradar --yes --with-config     # the configuration from the same backup too
```

The restore **never drops the main database**. The script does, in order:
1. restore the backup into a temporary database `jobradar_restore_<timestamp>` while web, runner and the ai-worker keep running. A damaged or unreadable backup fails here and nothing else has changed. Its row counts are printed next to the live database's. Without `--yes` the script stops here (exit status 1) and tells you what to run;
2. stop `web` and `runner` (`docker compose stop web runner`) and the **ai-worker** (macOS: `launchctl` with the label from `schedule.yaml` `doctor.ai_worker_launchd_label`; Linux: the user unit `job-radar-ai-worker.service`; if neither exists you get a notice and must stop the worker yourself, because it also writes to the database);
3. terminate every other connection to the main database, rename it to `jobradar_before_restore_<timestamp>` and give the restored copy the name `jobradar` (two renames; if the second fails, the first is undone). The old database is the safety copy, so no extra dump is taken and picking the wrong file costs nothing;
4. with `--with-config`: the backup's `.config.tgz` is checked before anything is touched (only regular files and directories under `data/config/` and `data/profile/`; links and absolute or `..` paths are refused) and unpacked into a staging folder `data/.restore-config-<timestamp>` (no owner from the archive, folders 755, files 600, as the app writes them). After the swap `data/config` and `data/profile` are renamed to `data/config.before-restore-<timestamp>` / `data/profile.before-restore-<timestamp>` and the staged folders are moved in. If that last step fails, the script prints where your old and the unpacked folders are, still starts the services and exits with status 1. The option needs the main database as target;
5. start `web`, `runner` and the ai-worker again (`--no-restart` leaves them stopped). The runner rolls the schema forward, so a backup from an older version restores onto newer code;
6. keep the newest `backup.keep_old_databases` replaced databases (default 1) and drop older ones, then print the rollback commands.

If the script is interrupted (Ctrl-C, `kill`, a lost terminal) or fails half-way, it undoes what it had started before it exits: it renames the main database back if the swap was half done, drops the temporary `jobradar_restore_<timestamp>` database it had created, removes the staging folder and starts `web`, `runner` and the ai-worker again if it had stopped them. It prints `== undoing what this run left half done` only when it had something to undo. If the terminal or the machine is gone before the script could do that (a power cut, `kill -9`), do it by hand: `docker compose start web runner`, and drop the leftover `jobradar_restore_*` databases (`docker compose exec db psql -U jobradar -d postgres -c '\l'` lists them).

Afterwards check: `docker compose ps` is all healthy; open `http://127.0.0.1:3000` and look at the job list; the runner log should contain a `catch-up` decision (after a restore the "latest cycle" becomes the state at backup time, so it may immediately re-run a cycle; this is expected). If the backup is from an older version run `pnpm config:migrate --write && pnpm config:check`.

### Undoing a restore

The database as it was before stays as `jobradar_before_restore_<timestamp>` until a later restore replaces it. To go back, with the commands the script printed (stop web and runner first; the ai-worker too):

```bash
docker compose stop web runner
docker compose exec db psql -U jobradar -d postgres -c 'alter database "jobradar" rename to "jobradar_after_restore_<timestamp>"'
docker compose exec db psql -U jobradar -d postgres -c 'alter database "jobradar_before_restore_<timestamp>" rename to "jobradar"'
docker compose start web runner
```

Drop the databases you no longer need with `drop database "<name>"`; they take disk space. After `--with-config` the previous configuration is in `data/config.before-restore-<timestamp>` and `data/profile.before-restore-<timestamp>`.

The script never overwrites the main database unless you pass `--target jobradar --yes`. Without `--target` it restores into a new temporary database and leaves the main one alone. With `--target jobradar` but without `--yes` it also restores into a temporary database `jobradar_restore_<timestamp>`, prints the row counts, and exits with status 1 and a hint to run the same command again with `--yes` (and how to drop the check copy); nothing else is changed.

To restore into another database (for example to pull the data of one table out for comparison): `scripts/ops/restore.sh <file> --target scratch_db`; if the target database already exists, `--yes` is required.

### Restoring the configuration  **[You do this]**

Without `--with-config` the script never touches configuration; when a `.config.tgz` sits next to the backup, it prints the restore commands. To restore by hand:

```bash
cp -R data/config data/config.before-restore          # first keep a copy of what is there now
tar -xzf data/backups/<name>.config.tgz -C .          # overwrites data/config and data/profile
pnpm config:migrate --write && pnpm config:check      # if the backup is from an older version, migrate first
docker compose restart web runner                     # the runner also hot-reloads within 5 seconds
```

If you want just one file: `tar -xzf <file>.config.tgz -C /tmp/cfg data/config/ai.yaml`, then compare and copy by hand. Before changing any file, `config:migrate --write` also puts the original into `data/config/.backup/<timestamp>/`; if a migration was a mistake, take it back from there.

## 5. Full rebuild (new machine, or the Docker data volume is lost)  **[You do this]**

1. Follow [host-setup.md](host-setup.md) to install Docker, clone the repository and run `pnpm install`, and put the backup files into `data/backups/` (if the project is on an external volume they are already there).
2. Start only the database: `docker compose up -d db`, and wait until db shows `healthy` in `docker compose ps`.
3. Restore (into an empty database, without restarting other services since they have not been created yet):

```bash
scripts/ops/restore.sh --latest --target jobradar --yes --no-restart
```

4. Put your configuration and profile back. They are not in the database; they come from the `.config.tgz` next to the dump (the daily backup writes one, so does `scripts/ops/backup.sh`; see [Restoring the configuration](#restoring-the-configuration--you-do-this)). Pick the newest one, check its listing, then restore `data/config` and `data/profile`:

```bash
ls -t data/backups/*.config.tgz | head -n 3
tar -tzf data/backups/<name>.config.tgz
tar -xzf data/backups/<name>.config.tgz -C .
```

   (On a fresh machine `--with-config` in the previous step does the same in one go, but it renames a `data/config` that is already there.) Without a `.config.tgz` you start with the defaults and have to enter your settings and profile again. Also recreate `.env` and `.auth/` yourself (they are never backed up).
5. Start all services: `docker compose up -d --build`. The runner runs migrations automatically on start (the dump contains the migration records; if already up to date, nothing happens).

## 6. Notes

- **When the config cannot be read** (no node or `node_modules` on the host, or an invalid `schedule.yaml`):
  - `backup.sh` still writes the backup and exits 0. It reads `timezone` with a strict shell reader instead; when that
    cannot read a valid zone either (missing, unclear, or a one-part name such as `Japan`, see
    [configuration](configuration.md#backup)), the file name carries UTC. A `!!! WARNING` says which. It prunes nothing
    in any case.
  - `restore.sh` runs in a degraded mode, with a `!!! WARNING`: backups are ordered and aged by their file modification
    time (UTC), not by the time in their names (name the file to restore to be sure); `backup.max_age_hours` comes from
    the shell reader (else 30, `--max-age-hours` still wins); and no replaced database is dropped, whatever
    `keep_old_databases` says. Drop the `<main>_before_restore_*` databases yourself when you no longer need them.
  - Fix the cause with `pnpm config:check` (and `pnpm install` when `node_modules` is missing).

- **Version**: dumps are produced by PostgreSQL 17 and can only be restored to a 17 or newer server. Before upgrading Postgres across a major version take a manual backup first, and upgrade `POSTGRES_CLIENT_VERSION` in the runner image to match (`tests/dockerfile.test.ts` fails if the two disagree).
- **Never `docker compose down -v`**: `-v` deletes the database volume.
- **`.env` and `.auth/` are in no backup**: `.env` holds your secrets and the database password, `.auth/` the LinkedIn login. Keep your own copy (a password manager for the values). Your configuration and profile are in the `.config.tgz` next to each dump; the shipped defaults in `config/` come with the repository.
- **Same disk**: the backups and the database are on the same disk, so they protect against mistakes, not against a failing disk. Copy `data/backups/` somewhere else on a schedule.
- **Permissions**: backup files and config archives are created readable by their owner only (`0600`), because they hold your whole database and your settings.
- **Disk space**: see `ls -lh` for the size of each backup; 14 + 8 backups (plus up to 5 safety backups of each kind) is about 22 times that size or more, so keep an eye on `df -h` as the data grows.

Config archives from both scheduled backups and `scripts/ops/backup.sh` exclude `.upgrade-freeze` and `.write.lock`, so restoring them cannot restore an upgrade freeze or writer lock.
