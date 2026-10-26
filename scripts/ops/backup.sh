#!/usr/bin/env bash
# Manual database backup: pg_dump (custom format, compressed) of the compose `db` service into
# data/backups/jobradar-manual-YYYYMMDD-HHMMSS[-label].dump, and next to it the user's config and profile
# (data/config + data/profile; without data/config/.backup and the web session secret) as ...[-label].config.tgz.
#
#   scripts/ops/backup.sh [--label NAME] [--dir DIR]
#
# Needs only Docker (pg_dump runs inside the db container; no Postgres client on the Mac). The stamp in the name is the
# wall clock of schedule.yaml `timezone`, like the runner's; without tzdata on this system the db container works it out. The runner's
# scheduled backups are named jobradar-YYYYMMDD-HHMMSS.dump and are pruned by the retention policy in
# config/schedule.yaml; manual backups use the `manual` name and are never pruned automatically.
set -euo pipefail
# Backups hold the whole database and the user's config: readable by the owner only.
umask 077

app="$(cd "$(dirname "$0")/../.." && pwd)"
dir="$app/data/backups"
label=""

# The header comment above (line 2 up to the first line that is not a comment); tests/ops/script-help.test.ts checks it names every option.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="${2:?--label needs a value}"; shift 2 ;;
    --dir) dir="${2:?--dir needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$label" && ! "$label" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "--label may only contain letters, digits, _ and -" >&2
  exit 2
fi

# File names use the schedule's wall clock, like the runner's. The user's schedule.yaml wins over the shipped one.
schedule="$app/data/config/schedule.yaml"
[[ -f "$schedule" ]] || schedule="$app/config/schedule.yaml"
tz="$(awk '/^timezone:/ { gsub(/["'"'"']/, "", $2); print $2; exit }' "$schedule" 2>/dev/null || true)"
tz="${tz:-Europe/Berlin}"
# shellcheck source=lib/timezone.sh
source "$app/scripts/ops/lib/timezone.sh"

cd "$app"
if ! docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  echo "the db service is not running (run: docker compose up -d db)" >&2
  exit 1
fi

if zone_known "$tz"; then
  stamp="$(TZ="$tz" date +%Y%m%d-%H%M%S)"
else
  # no tzdata here: `date` would silently print UTC and the name would not match the runner's. Postgres has its own zone database.
  stamp=""
  if [[ "$tz" =~ ^[A-Za-z0-9_+/-]+$ ]]; then
    stamp="$(docker compose exec -T db sh -c "psql -At -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"select to_char(now() at time zone '$tz', 'YYYYMMDD-HH24MISS')\"" 2>/dev/null | tr -d '\r' || true)"
  fi
  if [[ ! "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ ]]; then
    stamp="$(TZ=UTC date +%Y%m%d-%H%M%S)"
    echo "warning: this system has no time zone data for '$tz' and the database could not tell it either, so the file name carries UTC; the runner's backups use '$tz'. Install tzdata (see docs/host-setup.md)" >&2
  fi
fi
name="jobradar-manual-${stamp}${label:+-$label}.dump"

mkdir -p "$dir"
final="$dir/$name"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

# POSTGRES_USER / POSTGRES_DB are set inside the container, so nothing is read from .env here.
docker compose exec -T db sh -c 'pg_dump --format=custom --no-owner --no-acl -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$partial"

if [[ ! -s "$partial" ]] || [[ "$(head -c 5 "$partial")" != "PGDMP" ]]; then
  echo "pg_dump produced no valid archive; nothing was kept" >&2
  exit 1
fi

chmod 600 "$partial"
mv "$partial" "$final"
trap - EXIT
bytes="$(wc -c < "$final" | tr -d ' ')"
echo "backup written: $final ($bytes bytes)"

# The user's config and profile, which live outside the database and outside git. A failure here only warns:
# the database dump above is complete.
config_dirs=()
for sub in data/config data/profile; do [[ -d "$app/$sub" ]] && config_dirs+=("$sub"); done
if [[ ${#config_dirs[@]} -gt 0 ]]; then
  config_archive="${final%.dump}.config.tgz"
  # COPYFILE_DISABLE: macOS tar would write AppleDouble `._*` members for files with extended attributes (com.apple.provenance);
  # `--no-xattrs` alone does not stop them, and GNU tar on Linux then refuses the archive when it is restored there
  if COPYFILE_DISABLE=1 tar -czf "$config_archive.partial" --exclude 'data/config/.backup' --exclude '.web-session-secret' --exclude '.upgrade-freeze' --exclude '.write.lock' --exclude '.write.lock.guard*' -C "$app" "${config_dirs[@]}" && chmod 600 "$config_archive.partial" && mv "$config_archive.partial" "$config_archive"; then
    echo "config written: $config_archive (${config_dirs[*]})"
  else
    rm -f "$config_archive.partial"
    echo "warning: could not archive ${config_dirs[*]}; the database backup is fine" >&2
  fi
fi
