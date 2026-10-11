#!/usr/bin/env bash
# Restore a backup (pg_dump custom format) into the compose `db` service.
#
#   scripts/ops/restore.sh <file.dump | --latest> [--target NAME] [--yes] [--drop] [--no-restart] [--with-config] [--max-age-hours N]
#   scripts/ops/restore.sh --list
#
# Default: restore into a NEW temporary database (<main>_restore_<timestamp>), print every table's row
# count next to the live database's, and leave the temporary database for inspection (--drop removes it
# afterwards). The main database is never touched unless you pass --target <main db name> --yes.
#
# Restoring into the main database (--target <main> --yes) never drops it. The backup is first restored into a temporary
# database <main>_restore_<timestamp> while web, runner and ai-worker keep running (a damaged backup fails here and nothing
# else has changed), its row counts are shown, and only then: web and runner are stopped, the ai-worker is stopped
# (scripts/ops/lib/ai-worker.sh), every other connection to the main database is terminated, the main database is renamed to
# <main>_before_restore_<timestamp> and the temporary one takes its name. Then web, runner and ai-worker start again
# (--no-restart leaves them stopped; the runner rolls the schema forward, so an older backup restores onto newer code).
# The newest backup.keep_old_databases (schedule.yaml, default 1) replaced databases are kept, older ones are dropped, and the
# rollback commands are printed. Without --yes the script stops after the row counts and tells you what to run.
#
#   --latest        use the newest backup in data/backups, scheduled or manual, by the date and time in its file name
#                   (not by name order). The chosen file and its age are printed; when it is older than the limit
#                   (--max-age-hours, default: backup.max_age_hours of schedule.yaml) you must confirm, or pass --yes
#                   (a loud warning is still printed)
#   --list          show the backups newest first with their age, and exit
#   --max-age-hours N   age limit for --latest (default: schedule.yaml backup.max_age_hours, else 30)
#   --target NAME   restore into database NAME (created; an existing one needs --yes)
#   --yes           confirm overwriting an existing target / switching the main database
#   --drop          drop a temporary/other target again after the check
#   --no-restart    do not start web, runner and ai-worker after restoring the main database
#   --with-config   also put back data/config and data/profile from <backup>.config.tgz (only with the main database as target):
#                   the archive's members are checked first (only regular files and directories under data/config/ and data/profile/,
#                   no links, no absolute or .. paths), it is unpacked into data/.restore-config-<timestamp> (no owner from the archive,
#                   dirs 755, files 600), and after the database swap the current folders are renamed to
#                   data/config.before-restore-<timestamp> and data/profile.before-restore-<timestamp> and the unpacked ones moved in.
#                   If that last step fails the paths are printed, the services are started anyway and the exit status is 1. Run `pnpm config:migrate --write` afterwards if the backup is from an older version.
#
# Interrupted (Ctrl-C, kill, a lost terminal) or failing half-way, the script undoes what it started: it renames the main database back
# when the swap was half done, drops the temporary database it created, removes its staging folder, and starts web, runner and the
# ai-worker again if it had stopped them. When there is nothing to undo it prints nothing.
#
# A backup has the user's config and profile next to it (<name>.config.tgz) when it was made by the runner (backup.config_archive)
# or by scripts/ops/backup.sh. Without --with-config this script never touches them; it prints the command that puts them back
# (see docs/backup-restore.md). .env and .auth/ are never in a backup: keep your own copy.
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/../.." && pwd)"
app="$root"
backups="$app/data/backups"
file=""
target=""
yes=0
drop=0
restart=1
with_config=0
list_only=0
max_age_hours=""

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --latest) file="LATEST"; shift ;;
    --target) target="${2:?--target needs a database name}"; shift 2 ;;
    --yes) yes=1; shift ;;
    --drop) drop=1; shift ;;
    --no-restart) restart=0; shift ;;
    --with-config) with_config=1; shift ;;
    --list) list_only=1; shift ;;
    --max-age-hours) max_age_hours="${2:?--max-age-hours needs a number}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [[ -z "$file" ]] || { echo "only one backup file at a time" >&2; exit 2; }; file="$1"; shift ;;
  esac
done

if [[ -n "$max_age_hours" && ! "$max_age_hours" =~ ^[0-9]+$ ]]; then
  echo "--max-age-hours must be a whole number" >&2
  exit 2
fi

# The schedule's wall clock names the files; the user's schedule.yaml wins over the shipped one.
schedule="$app/data/config/schedule.yaml"
[[ -f "$schedule" ]] || schedule="$app/config/schedule.yaml"
tz="$(awk '/^timezone:/ { gsub(/["'"'"']/, "", $2); print $2; exit }' "$schedule" 2>/dev/null || true)"
tz="${tz:-Europe/Berlin}"
# shellcheck source=lib/timezone.sh
source "$root/scripts/ops/lib/timezone.sh"
tz_known=1
if ! zone_known "$tz"; then
  tz_known=0
  echo "warning: this system has no time zone data for '$tz' (install tzdata), so the dates in the file names cannot be converted: backups are ordered and aged by their file modification time" >&2
fi
if [[ -z "$max_age_hours" ]]; then
  max_age_hours="$(awk '/^backup:/ { in_backup = 1; next } /^[^ #]/ { in_backup = 0 } in_backup && $1 == "max_age_hours:" { print $2; exit }' "$schedule" 2>/dev/null || true)"
  [[ "$max_age_hours" =~ ^[0-9]+$ ]] || max_age_hours=30
fi
keep_old="$(awk '/^backup:/ { in_backup = 1; next } /^[^ #]/ { in_backup = 0 } in_backup && $1 == "keep_old_databases:" { print $2; exit }' "$schedule" 2>/dev/null || true)"
[[ "$keep_old" =~ ^[0-9]+$ && "$keep_old" -ge 1 ]] || keep_old=1
# Base 10 explicitly: a value such as 08 would otherwise be read as (invalid) octal by bash arithmetic.
max_age_hours=$((10#$max_age_hours))

# "YYYYMMDD HHMMSS" (wall clock in $tz) -> epoch seconds; empty when this `date` cannot parse it.
stamp_epoch() {
  local d="$1" t="$2" e=""
  e="$(TZ="$tz" date -j -f '%Y%m%d%H%M%S' "$d$t" +%s 2>/dev/null || true)"
  [[ -n "$e" ]] || e="$(TZ="$tz" date -d "${d:0:4}-${d:4:2}-${d:6:2} ${t:0:2}:${t:2:2}:${t:4:2}" +%s 2>/dev/null || true)"
  printf '%s' "$e"
}
# GNU stat first: there `stat -f` is "file system status" and prints a multi-line report (exit 1) instead of the mtime.
file_mtime() {
  local m
  m="$(stat -c %Y "$1" 2>/dev/null || true)"
  [[ "$m" =~ ^[0-9]+$ ]] || m="$(stat -f %m "$1" 2>/dev/null || true)"
  [[ "$m" =~ ^[0-9]+$ ]] || m=0
  printf '%s\n' "$m"
}

# Prints "sortkey<TAB>epoch<TAB>path", newest first. Both name formats are understood:
#   jobradar-YYYYMMDD-HHMMSS.dump                (scheduled)
#   jobradar-manual-YYYYMMDD-HHMMSS[-label].dump (manual, also pre-restore / pre-deploy)
# A name without a date falls back to the file's modification time.
list_backups() {
  local f base d t e key
  shopt -s nullglob
  for f in "$backups"/jobradar-*.dump; do
    base="$(basename "$f")"
    if [[ "$tz_known" == 0 ]]; then
      # the names are in a zone this system cannot resolve: the modification time is the only reliable clock
      e="$(file_mtime "$f")"
      printf '%014d\t%s\t%s\n' "$e" "$e" "$f"
      continue
    fi
    if [[ "$base" =~ ^jobradar-(manual-)?([0-9]{8})-([0-9]{6})([-.].*)?$ ]]; then
      d="${BASH_REMATCH[2]}"; t="${BASH_REMATCH[3]}"
      e="$(stamp_epoch "$d" "$t")"
      key="$d$t"
    else
      e="$(file_mtime "$f")"
      key="$(TZ="$tz" date -r "$e" +%Y%m%d%H%M%S 2>/dev/null || TZ="$tz" date -d "@$e" +%Y%m%d%H%M%S 2>/dev/null || echo 00000000000000)"
    fi
    [[ -n "$e" ]] || e="$(file_mtime "$f")"
    printf '%s\t%s\t%s\n' "$key" "$e" "$f"
  done | LC_ALL=C sort -r -t "$(printf '\t')" -k1,1 -k3,3
}

human_age() {
  local secs="$1"
  (( secs < 0 )) && secs=0
  if (( secs < 3600 )); then printf '%d min' $(( secs / 60 ))
  elif (( secs < 172800 )); then printf '%d h' $(( secs / 3600 ))
  else printf '%d days' $(( secs / 86400 )); fi
}

if [[ "$list_only" == 1 ]]; then
  now="$(date +%s)"
  found=0
  printf '%-52s %-8s %s\n' "backup (newest first)" "config" "age"
  while IFS=$'\t' read -r _ epoch path; do
    found=1
    cfg="-"; [[ -f "${path%.dump}.config.tgz" ]] && cfg="yes"
    printf '%-52s %-8s %s\n' "$(basename "$path")" "$cfg" "$(human_age $(( now - epoch )))"
  done < <(list_backups)
  [[ "$found" == 1 ]] || { echo "no backups in $backups" >&2; exit 1; }
  exit 0
fi

if [[ -z "$file" ]]; then
  usage >&2
  exit 2
fi
if [[ "$file" == "LATEST" ]]; then
  newest="$(list_backups | head -n 1)"
  [[ -n "$newest" ]] || { echo "no backups in $backups" >&2; exit 1; }
  IFS=$'\t' read -r _ newest_epoch file <<< "$newest"
  age_secs=$(( $(date +%s) - newest_epoch ))
  echo "== newest backup: $(basename "$file") (age $(human_age "$age_secs"); limit ${max_age_hours} h)"
  if (( age_secs > max_age_hours * 3600 )); then
    echo "!!! WARNING: this is the newest backup, but it is older than ${max_age_hours} hours." >&2
    echo "!!! Restoring it brings back data from $(human_age "$age_secs") ago; everything newer is lost. See: $0 --list" >&2
    if [[ "$yes" != 1 ]]; then
      if [[ -t 0 ]]; then
        read -r -p "Use this old backup anyway? [y/N] " answer
        [[ "$answer" =~ ^[Yy]$ ]] || { echo "aborted" >&2; exit 1; }
      else
        echo "refusing to use an old backup without confirmation; pass --yes to accept it" >&2
        exit 1
      fi
    fi
  fi
fi
[[ -f "$file" ]] || { echo "not a file: $file" >&2; exit 1; }
file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
if [[ "$(head -c 5 "$file")" != "PGDMP" ]]; then
  echo "not a pg_dump custom-format archive: $file" >&2
  exit 1
fi

config_archive="${file%.dump}.config.tgz"
if [[ "$with_config" == 1 ]]; then
  # Checked before anything is touched: a hostile or damaged archive must not get as far as the folders.
  [[ -f "$config_archive" ]] || { echo "--with-config: there is no $(basename "$config_archive") next to the backup" >&2; exit 1; }
  # AppleDouble members (`._*`, written by macOS tar for files with extended attributes) carry no settings: they are left out of the
  # checks and of the unpacking alike (the same --exclude in all three tar calls, so nothing unchecked is ever unpacked).
  members="$(tar -tzf "$config_archive" --exclude '._*')" || { echo "--with-config: cannot read $config_archive" >&2; exit 1; }
  [[ -n "$members" ]] || { echo "--with-config: $config_archive is empty" >&2; exit 1; }
  # Only regular files and directories: the first character of the mode column is '-' or 'd' (a symlink is 'l', a hard link 'h').
  kinds="$(tar -tvzf "$config_archive" --exclude '._*')" || { echo "--with-config: cannot read $config_archive" >&2; exit 1; }
  while IFS= read -r line; do
    case "${line:0:1}" in
      -|d) ;;
      *) echo "--with-config: refusing $config_archive: it contains something other than regular files and directories (a link or a special file)" >&2; exit 1 ;;
    esac
  done <<< "$kinds"
  while IFS= read -r member; do
    case "$member" in
      /*|..|../*|*/..|*/../*) echo "--with-config: refusing $config_archive: unsafe path '$member'" >&2; exit 1 ;;
      data/config|data/config/*|data/profile|data/profile/*) ;;
      *) echo "--with-config: refusing $config_archive: '$member' is outside data/config and data/profile" >&2; exit 1 ;;
    esac
  done <<< "$members"
fi

cd "$app"
if ! docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  echo "the db service is not running (run: docker compose up -d db)" >&2
  exit 1
fi

# Everything below runs inside the db container, where POSTGRES_USER / POSTGRES_DB are defined.
dbx() { docker compose exec -T db "$@"; }
pg_user="$(dbx sh -c 'printf %s "$POSTGRES_USER"')"
main_db="$(dbx sh -c 'printf %s "$POSTGRES_DB"')"
psql_admin() { dbx psql -v ON_ERROR_STOP=1 -X -q -U "$pg_user" -d postgres "$@"; }

# shellcheck source=lib/ai-worker.sh
source "$root/scripts/ops/lib/ai-worker.sh"

# ---- undo on exit ------------------------------------------------------------------------------------------------
# Each step that changes something arms one of these before it starts; the step that makes the change permanent (or the
# deliberate "keep it for inspection") disarms it. Whatever is still armed when the script ends, however it ends (an error,
# Ctrl-C, SIGTERM), is undone in this order: the main database renamed back, the temporary database dropped, the staging folder
# removed, web / runner / ai-worker started. Nothing armed: no output, no calls.
undo_temp_db=""        # a database this run created that nobody should be left with
undo_rename_from=""    # the main database was (or is being) renamed to this name; set while its replacement is not in place yet
undo_stage=""          # the unpacked configuration of --with-config
undo_services=0        # web and runner (and the ai-worker) were stopped by this run
cleanup_done=0

db_exists() { [[ "$(psql_admin -At -c "select 1 from pg_database where datname = '$1'" 2>/dev/null || true)" == "1" ]]; }

undo_on_exit() {
  [[ "$cleanup_done" == 0 ]] || return 0
  cleanup_done=1
  set +e
  trap - EXIT INT TERM
  if [[ -z "$undo_temp_db$undo_rename_from$undo_stage" && "$undo_services" == 0 ]]; then return 0; fi
  echo "== undoing what this run left half done" >&2
  if [[ -n "$undo_rename_from" ]] && db_exists "$undo_rename_from" && ! db_exists "$main_db"; then
    echo "putting '$undo_rename_from' back as '$main_db'" >&2
    rename_db "$undo_rename_from" "$main_db" || echo "!!! could not put '$undo_rename_from' back: docker compose exec db psql -U $pg_user -d postgres -c 'alter database \"$undo_rename_from\" rename to \"$main_db\"'" >&2
  fi
  if [[ -n "$undo_temp_db" ]]; then
    echo "dropping the unfinished copy '$undo_temp_db'" >&2
    psql_admin -c "drop database if exists \"$undo_temp_db\" with (force)" || echo "could not drop '$undo_temp_db'; drop it yourself" >&2
  fi
  if [[ -n "$undo_stage" ]]; then rm -rf "$undo_stage"; fi
  if [[ "$undo_services" == 1 ]]; then
    if db_exists "$main_db"; then
      echo "starting web, runner and the ai-worker again" >&2
      docker compose start web runner || echo "could not start web and runner; run: docker compose up -d --build" >&2
      ai_worker_start
    else
      echo "!!! there is no database '$main_db' right now, so web, runner and the ai-worker stay stopped; put the database back first (see above), then: docker compose start web runner" >&2
    fi
  fi
  return 0
}
trap undo_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Ends every other connection to $1, then renames it; repeated, because a client that reconnects in between makes the rename fail.
rename_db() {
  local from="$1" to="$2" attempt
  for attempt in 1 2 3; do
    psql_admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$from' and pid <> pg_backend_pid()" > /dev/null || true
    if psql_admin -c "alter database \"$from\" rename to \"$to\""; then return 0; fi
    sleep "${RESTORE_RENAME_RETRY_SECONDS:-1}"
  done
  return 1
}

temporary=0
if [[ -z "$target" ]]; then
  target="${main_db}_restore_$(date +%Y%m%d%H%M%S)"
  temporary=1
fi
if [[ ! "$target" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "invalid database name: $target (letters, digits and _ only)" >&2
  exit 2
fi

is_main=0
[[ "$target" == "$main_db" ]] && is_main=1
exists="$(psql_admin -At -c "select 1 from pg_database where datname = '$target'")"

if [[ "$with_config" == 1 && "$is_main" != 1 ]]; then
  echo "--with-config replaces the live data/config and data/profile: use it with --target $main_db --yes" >&2
  exit 2
fi
if [[ "$is_main" != 1 && "$exists" == "1" && "$yes" != 1 ]]; then
  echo "database '$target' already exists; pass --yes to drop and recreate it" >&2
  exit 1
fi

# Exact row counts of every user table: "schema.table<TAB>rows".
count_rows() {
  dbx psql -X -At -F $'\t' -U "$pg_user" -d "$1" -c "
    select table_schema || '.' || table_name,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
    order by 1"
}

# The database the backup is restored into first. For the main database that is a new temporary one: the main database
# itself is not touched until the swap below.
stamp="$(date +%Y%m%d%H%M%S)"
restore_into="$target"
if [[ "$is_main" == 1 ]]; then
  restore_into="${main_db}_restore_${stamp}"

  echo "== checking the archive and the free disk space"
  if ! dbx pg_restore --list < "$file" > /dev/null; then
    echo "pg_restore cannot read $(basename "$file"): the backup is damaged. Nothing was changed." >&2
    exit 1
  fi
  db_bytes="$(psql_admin -At -c "select pg_database_size('$main_db')")"
  free_kb="$(dbx sh -c 'df -Pk "${PGDATA:-/var/lib/postgresql/data}" | awk "NR == 2 { print \$4 }"' 2>/dev/null || true)"
  if [[ "$db_bytes" =~ ^[0-9]+$ && "$free_kb" =~ ^[0-9]+$ ]]; then
    if (( free_kb * 1024 < db_bytes * 2 )); then
      echo "not enough free disk space for a second copy of the database: $(( free_kb / 1024 )) MB free, $(( db_bytes * 2 / 1048576 )) MB needed (twice the current size). Nothing was changed." >&2
      exit 1
    fi
  else
    echo "warning: could not measure the free disk space in the db container; make sure there is room for a second copy of the database" >&2
  fi
  exists=0
fi

echo "== restoring $(basename "$file") into '$restore_into'"
if [[ "$exists" == "1" ]]; then
  psql_admin -c "drop database \"$restore_into\" with (force)"
fi
undo_temp_db="$restore_into"   # armed before it exists: an interrupt right after the create still drops it
psql_admin -c "create database \"$restore_into\""
if ! dbx pg_restore --no-owner --no-acl --exit-on-error -U "$pg_user" -d "$restore_into" < "$file"; then
  echo "pg_restore failed; '$restore_into' is incomplete" >&2
  if [[ "$is_main" == 1 ]]; then
    psql_admin -c "drop database if exists \"$restore_into\" with (force)" || true
    echo "the main database '$main_db' was not touched and web, runner and the ai-worker were not stopped" >&2
  fi
  undo_temp_db=""   # reported above; the incomplete copy of a named target stays, as it always did
  exit 1
fi

echo "== row counts (restored '$restore_into' vs live '$main_db')"
restored="$(count_rows "$restore_into")"
live="$(count_rows "$main_db")"
LC_ALL=C join -t $'\t' -a1 -a2 -e '-' -o 0,1.2,2.2 \
  <(printf '%s\n' "$restored" | LC_ALL=C sort) <(printf '%s\n' "$live" | LC_ALL=C sort) |
  awk -F'\t' 'BEGIN { printf "%-40s %10s %10s\n", "table", "restored", "live" } { printf "%-40s %10s %10s\n", $1, $2, $3 }'
printf '%s\n' "$restored" | awk -F'\t' '{ n += 1; rows += $2 } END { printf "restored: %d tables, %d rows\n", n, rows }'
printf '%s\n' "$live" | awk -F'\t' '{ n += 1; rows += $2 } END { printf "live:     %d tables, %d rows (it may have moved on since the backup was taken)\n", n, rows }'

if [[ -f "$config_archive" ]]; then
  echo "== the config and profile of this backup: $config_archive"
  if [[ "$with_config" != 1 ]]; then
    echo "  not restored automatically (add --with-config), or by hand (replaces data/config and data/profile; keep a copy first):"
    echo "  tar -tzf '$config_archive'                     # list"
    echo "  tar -xzf '$config_archive' -C '$app'           # restore, then: docker compose restart web runner"
  fi
elif [[ "$with_config" != 1 ]]; then
  echo "== this backup has no config archive next to it (${config_archive##*/}); your data/config and data/profile stay as they are"
fi

if [[ "$is_main" != 1 ]]; then
  undo_temp_db=""   # kept for inspection (or dropped below)
  if [[ "$drop" == 1 ]]; then
    psql_admin -c "drop database \"$target\" with (force)"
    echo "dropped '$target'"
  else
    echo "database '$target' is kept for inspection:"
    echo "  docker compose exec db psql -U $pg_user -d $target"
    echo "drop it with:"
    echo "  docker compose exec db psql -U $pg_user -d postgres -c 'drop database \"$target\"'"
  fi
  exit 0
fi

# ---- the main database: sanity checks, then the swap -------------------------------------------------------
table_count="$(printf '%s\n' "$restored" | grep -c . || true)"
if ! printf '%s\n' "$restored" | grep -q '^drizzle\.__drizzle_migrations'$'\t' || (( table_count < 1 )); then
  echo "the restored database has no drizzle.__drizzle_migrations table or no tables at all; this does not look like a Job Radar backup. Nothing was switched." >&2
  echo "inspect: docker compose exec db psql -U $pg_user -d $restore_into   (drop it when done)" >&2
  undo_temp_db=""   # kept for inspection, as said above
  exit 1
fi
if [[ "$yes" != 1 ]]; then
  undo_temp_db=""   # the check copy is kept on purpose; the message below says how to drop it
  echo "== the backup restored cleanly into '$restore_into'; the main database '$main_db' is untouched." >&2
  echo "To switch to it (web, runner and the ai-worker stop for a moment), run the same command with --yes. Drop the check copy with:" >&2
  echo "  docker compose exec db psql -U $pg_user -d postgres -c 'drop database \"$restore_into\"'" >&2
  exit 1
fi

# --with-config: unpack the archive next to the live folders now (same disk, so the final move is a rename), before anything is
# stopped or switched. Nothing in it is trusted: no owner from the archive, dirs 755 and files 600 like the app writes them
# (the containers run as the host user, PUID/PGID).
config_stage=""
if [[ "$with_config" == 1 ]]; then
  config_stage="$app/data/.restore-config-$stamp"
  rm -rf "$config_stage"
  mkdir -p "$config_stage"
  undo_stage="$config_stage"
  echo "== unpacking $(basename "$config_archive") into $config_stage"
  # bsdtar (macOS) would otherwise merge a `._x` member into `x` as metadata, and fails on one that is not a valid resource fork
  tar_plain=(); if tar --version 2>&1 | grep -qi bsdtar && tar --no-mac-metadata --version >/dev/null 2>&1; then tar_plain=(--no-mac-metadata); fi
  if ! ( umask 022; tar -xzf "$config_archive" -C "$config_stage" --no-same-owner --exclude '._*' ${tar_plain[@]+"${tar_plain[@]}"} ); then
    rm -rf "$config_stage"
    undo_stage=""
    echo "--with-config: could not unpack $config_archive; nothing was changed" >&2
    exit 1
  fi
  mkdir -p "$config_stage/data/config" "$config_stage/data/profile"
  find "$config_stage" -type d -exec chmod 755 {} +
  find "$config_stage" -type f -exec chmod 600 {} +
fi

old_db="${main_db}_before_restore_${stamp}"

echo "== stopping web, runner and the ai-worker"
undo_services=1
docker compose stop web runner
ai_worker_stop

switched=0
echo "== switching: '$main_db' -> '$old_db', '$restore_into' -> '$main_db'"
undo_rename_from="$old_db"   # armed before the rename: a signal that arrives right after it still finds the work to undo
if rename_db "$main_db" "$old_db"; then
  if rename_db "$restore_into" "$main_db"; then
    switched=1
    undo_rename_from=""
    undo_temp_db=""   # the restored copy is the main database now
  else
    echo "could not rename '$restore_into' to '$main_db'; putting the old database back" >&2
    undo_temp_db=""   # the restored copy stays as '$restore_into', as the message at the end says
    if rename_db "$old_db" "$main_db"; then
      undo_rename_from=""
    else
      echo "!!! could not put '$old_db' back as '$main_db', so there is no main database and web and runner are NOT started." >&2
      echo "    rename it yourself: docker compose exec db psql -U $pg_user -d postgres -c 'alter database \"$old_db\" rename to \"$main_db\"'" >&2
      echo "    then: docker compose start web runner" >&2
      exit 1   # the exit trap tries the rename once more and starts nothing while '$main_db' is missing
    fi
  fi
else
  echo "could not rename '$main_db' (something keeps reconnecting to it); nothing was switched" >&2
  undo_rename_from=""
  undo_temp_db=""   # the restored copy stays as '$restore_into', as the message at the end says
fi

config_failed=0
if [[ "$switched" == 1 && "$with_config" == 1 ]]; then
  undo_stage=""   # from here on the staged folders are the only copy of the unpacked configuration: keep them if anything breaks
  echo "== putting back data/config and data/profile from $(basename "$config_archive")"
  for sub in config profile; do
    if [[ -e "$app/data/$sub" ]]; then mv "$app/data/$sub" "$app/data/$sub.before-restore-$stamp" || config_failed=1; fi
  done
  if [[ "$config_failed" == 0 ]]; then
    for sub in config profile; do
      mv "$config_stage/data/$sub" "$app/data/$sub" || config_failed=1
    done
  fi
  if [[ "$config_failed" == 0 ]]; then
    echo "  the previous folders are kept as data/config.before-restore-$stamp and data/profile.before-restore-$stamp"
    echo "  if the backup is from an older version, run: pnpm config:migrate --write"
  else
    echo "!!! could not put the configuration back. The database restore is done and the services are started below anyway." >&2
    echo "    your previous folders: $app/data/config.before-restore-$stamp and $app/data/profile.before-restore-$stamp (if they exist, move them back to data/config and data/profile)" >&2
    echo "    the unpacked backup: $config_stage/data (move data/config and data/profile from there into $app/data yourself)" >&2
  fi
fi
if [[ -n "$config_stage" && "$config_failed" == 0 ]]; then rm -rf "$config_stage"; fi

if [[ "$restart" == 1 ]]; then
  echo "== starting web and runner"
  docker compose start web runner || echo "could not start web and runner (not created yet?); run: docker compose up -d --build" >&2
  ai_worker_start
  undo_services=0
else
  undo_services=0
  echo "web, runner and the ai-worker stay stopped; start them with: docker compose start web runner (and the ai-worker: scripts/ops/install-ai-worker.sh, or systemctl --user start job-radar-ai-worker.service)"
fi

if [[ "$switched" != 1 ]]; then
  if [[ -n "$config_stage" ]]; then rm -rf "$config_stage"; fi
  undo_stage=""
  echo "the restore did NOT take effect: '$main_db' is as before. The restored copy stays as '$restore_into'." >&2
  exit 1
fi

# Replaced databases: keep the newest $keep_old, drop the rest. Never the main database.
replaced="$(psql_admin -At -c "select datname from pg_database where datname ~ '^${main_db}_before_restore_[0-9]{14}\$' order by datname desc" || true)"
index=0
while IFS= read -r name; do
  [[ -n "$name" ]] || continue
  index=$(( index + 1 ))
  (( index > keep_old )) || continue
  if psql_admin -c "drop database \"$name\" with (force)"; then
    echo "dropped the older replaced database '$name'"
  else
    echo "could not drop '$name'; drop it yourself when you no longer need it" >&2
  fi
done <<< "$replaced"

echo "== done: '$main_db' now holds $(basename "$file")"
echo "The database as it was before is kept as '$old_db'. To go back (stop web and runner first):"
echo "  docker compose stop web runner"
echo "  docker compose exec db psql -U $pg_user -d postgres -c 'alter database \"$main_db\" rename to \"${main_db}_after_restore_${stamp}\"'"
echo "  docker compose exec db psql -U $pg_user -d postgres -c 'alter database \"$old_db\" rename to \"$main_db\"'"
echo "  docker compose start web runner"
[[ "$config_failed" == 0 ]] || { echo "the configuration was NOT restored (see above)" >&2; exit 1; }
