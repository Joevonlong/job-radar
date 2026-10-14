#!/usr/bin/env bash
# Remove the host AI worker service: on macOS the launchd agent (`launchctl bootout`, then its plist is deleted), on Linux
# the systemd user unit job-radar-ai-worker.service (`systemctl --user disable --now`, then the unit file is deleted).
# The definition is found by the same identity rules as install-ai-worker.sh (scripts/ops/lib/ai-worker.sh): the label
# doctor.ai_worker_launchd_label of schedule.yaml (a custom one too), the default io.jobradar.ai-worker or the old
# de.jobradar.ai-worker. Leaves the logs, the release directories (data/releases/) and an unresolved switch backup
# (data/run/ai-worker-swap-backup/, its location is printed).
#
#   scripts/ops/uninstall-ai-worker.sh [--purge-logs] [--root <checkout>]
#
#   --purge-logs     also delete the logs: data/logs/ai-worker.* and (macOS) ~/Library/Logs/job-radar/ai-worker.*
#                    (launchd's capture file, and the logs of earlier installs)
#   --root <path>    the main checkout (its schedule.yaml names the label; its data/logs are purged); default: the MAIN
#                    checkout, like install-ai-worker.sh
#
# Exit code: 0 = no ai-worker definition is left (or none was installed); 1 = more than one definition was found (nothing
# is changed: the definitions and the commands to remove them by hand are printed), or the worker did not stop within
# deploy.ai_worker_swap_timeout_seconds (its definition is kept).
# AI requests queue up in the database while the worker is gone; /sources shows the worker as not responding.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PURGE=0
ROOT=""

# The header comment above (line 2 up to the first line that is not a comment); tests/ops/script-help.test.ts checks it names every option.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
die() { echo "uninstall-ai-worker: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-logs) PURGE=1 ;;
    --root) [[ $# -ge 2 ]] || die "--root needs a path"; ROOT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

# shellcheck source=lib/ai-worker.sh
source "$SCRIPT_DIR/lib/ai-worker.sh"

# the main checkout (same lookup as install-ai-worker.sh)
if [[ -z "$ROOT" ]]; then
  product="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
  top="$(git -C "$product" rev-parse --show-toplevel 2>/dev/null || true)"
  common="$(git -C "$product" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common" && -n "$top" ]]; then
    top="$(cd "$top" && pwd -P)"
    [[ "$common" = /* ]] || common="$product/$common"
    common="$(cd "$common" && pwd -P)"
    if [[ "$(basename "$common")" == ".git" ]]; then ROOT="$(dirname "$common")${product#"$top"}"; fi
  fi
  [[ -n "$ROOT" ]] || ROOT="$product"
fi
ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P)" || die "--root: no such directory"
# Transitional: --root may still name a workspace checkout that holds the product in job-radar/.
if [[ ! -f "$ROOT/package.json" && -f "$ROOT/job-radar/package.json" ]]; then ROOT="$ROOT/job-radar"; fi
MAIN_DIR="$ROOT"

SYSTEMD_UNIT="$AI_WORKER_SYSTEMD_UNIT"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SYSTEMD_UNIT"
DOMAIN="gui/$(id -u)"
MANAGER="${JOB_RADAR_SERVICE_MANAGER:-}"
case "$MANAGER" in
  launchd|systemd) ;;
  "") if [[ "$(uname -s)" == "Darwin" ]]; then MANAGER=launchd; else MANAGER=systemd; fi ;;
  *) die "JOB_RADAR_SERVICE_MANAGER must be launchd or systemd, got '$MANAGER'" ;;
esac
export JOB_RADAR_SERVICE_MANAGER="$MANAGER"

# Why there is no usable systemd user manager (empty when there is one); the same wording as install-ai-worker.sh.
systemd_user_problem() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is not installed (this system does not run systemd)"
  elif systemctl --user show-environment >/dev/null 2>&1; then
    echo ""
  elif [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    echo "systemctl --user cannot reach your user manager and XDG_RUNTIME_DIR is not set (typical for sudo, su or a cron shell): run this script from a normal login of this user, or export XDG_RUNTIME_DIR=/run/user/$(id -u)"
  else
    echo "systemctl --user cannot reach your user manager (no login session of this user is running it): run 'sudo loginctl enable-linger $(id -un)', then log in again"
  fi
}

purge_logs() {
  [[ "$PURGE" -eq 1 ]] || return 0
  if [[ "$MANAGER" == launchd ]]; then
    # launchd's capture file and the logs of earlier installs (rotated copies included)
    rm -f "$HOME/Library/Logs/job-radar/"ai-worker.*
    echo "removed the ai-worker logs under ~/Library/Logs/job-radar"
  fi
  if [[ -d "$MAIN_DIR/data/logs" ]]; then
    rm -f "$MAIN_DIR/data/logs/"ai-worker.*
    echo "removed the ai-worker logs under $MAIN_DIR/data/logs"
  else
    echo "no data/logs found under $MAIN_DIR; pass --root <main checkout> to purge the worker logs"
  fi
}
note_backup() {
  local backup="$MAIN_DIR/data/run/ai-worker-swap-backup"
  [[ -e "$backup" ]] || return 0
  echo "note: an unresolved switch backup is kept: $backup (see docs/upgrade.md before removing it)"
}

if [[ "$MANAGER" == systemd ]]; then
  SYSTEMD_PROBLEM="$(systemd_user_problem)"
  if [[ -n "$SYSTEMD_PROBLEM" ]]; then
    if [[ -e "$UNIT_FILE" ]]; then
      echo "uninstall-ai-worker: $UNIT_FILE exists, but the unit cannot be stopped: $SYSTEMD_PROBLEM." >&2
      echo "Nothing was removed; fix that and run this script again." >&2
      exit 1
    fi
    echo "no $SYSTEMD_UNIT installed ($UNIT_FILE does not exist)"
    note_backup; purge_logs
    exit 0
  fi
fi

if ! IDENT="$(ai_worker_identity "$MAIN_DIR")"; then
  echo "uninstall-ai-worker: the ai-worker service identity is ambiguous (see above): nothing was changed." >&2
  if [[ "$MANAGER" == launchd ]]; then
    echo "Remove the definitions by hand, one by one:" >&2
    for label in "$AI_WORKER_DEFAULT_LABEL" "$AI_WORKER_LEGACY_LABEL" "<your doctor.ai_worker_launchd_label>"; do
      echo "  launchctl bootout $DOMAIN/$label; rm ~/Library/LaunchAgents/$label.plist" >&2
    done
  else
    echo "Fix doctor.ai_worker_launchd_label in schedule.yaml, or remove the unit by hand:" >&2
    echo "  systemctl --user disable --now $SYSTEMD_UNIT; rm $UNIT_FILE; systemctl --user daemon-reload" >&2
  fi
  exit 1
fi
ident_value() { printf '%s\n' "$IDENT" | sed -n "s/^$1=//p" | head -n 1; }
ORIGIN="$(ident_value origin)"
FOUND_LABEL="$(ident_value found_label)"
FOUND_DEF="$(ident_value found_definition)"
if [[ "$ORIGIN" == none ]]; then
  if [[ "$MANAGER" == systemd ]]; then echo "no $SYSTEMD_UNIT installed ($UNIT_FILE does not exist)"
  else echo "no ai-worker agent installed (no plist for $(ident_value label), $AI_WORKER_DEFAULT_LABEL or $AI_WORKER_LEGACY_LABEL)"; fi
  note_backup; purge_logs
  exit 0
fi

ai_worker_deploy_settings "$MAIN_DIR"
PID="$(ai_worker_service_pid "$MANAGER" "$FOUND_LABEL" "$AI_WORKER_SWAP_TIMEOUT")"
if [[ "$MANAGER" == launchd ]]; then
  if launchctl print "$DOMAIN/$FOUND_LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$FOUND_LABEL" 2>/dev/null || true
  fi
else
  systemctl --user disable --now "$SYSTEMD_UNIT" >/dev/null 2>&1 || systemctl --user stop "$SYSTEMD_UNIT" || true
fi
if ! ai_worker_wait_stopped "$FOUND_LABEL" "$PID" "$AI_WORKER_SWAP_TIMEOUT"; then
  echo "uninstall-ai-worker: $FOUND_LABEL${PID:+ (pid $PID)} did not stop within $AI_WORKER_SWAP_TIMEOUT s; its definition $FOUND_DEF is kept" >&2
  exit 1
fi
echo "stopped $FOUND_LABEL"
rm -f "$FOUND_DEF"
[[ "$MANAGER" == launchd ]] || systemctl --user daemon-reload || true
echo "removed $FOUND_DEF"
note_backup
purge_logs
echo "uninstalled: no ai-worker definition is left (release directories under data/releases/ai-worker/ are kept)"
