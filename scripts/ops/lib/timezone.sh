#!/usr/bin/env bash
# Time zone helpers for backup.sh and restore.sh. Sourced (not run on its own).
#
# The runner names its backups with the wall clock of `timezone` in schedule.yaml, through Node's Intl. The scripts use
# `TZ=<zone> date`, which prints UTC without a word when the system has no tzdata (a minimal container, a bare VM): files
# written by the two would carry stamps hours apart and `restore.sh --latest` would sort them wrongly.
#
#   zone_known <zone>   success when this system can resolve the zone (UTC and GMT always can)

zone_known() {
  local zone="$1" dir
  case "$zone" in UTC|Etc/UTC|GMT|Etc/GMT|Z|Zulu) return 0 ;; esac
  # a zone name is letters, digits and _ + - /; anything else (".." included) is never looked up
  [[ "$zone" =~ ^[A-Za-z0-9_+/-]+$ && "$zone" != *..* ]] || return 1
  for dir in "${TZDIR:-}" /usr/share/zoneinfo /usr/lib/zoneinfo /usr/share/lib/zoneinfo /var/db/timezone/zoneinfo; do
    [[ -n "$dir" && -f "$dir/$zone" ]] && return 0
  done
  return 1
}
