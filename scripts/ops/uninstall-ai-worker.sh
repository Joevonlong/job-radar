#!/usr/bin/env bash
# Remove the host AI worker service: on macOS the launchd agent (stops it with `launchctl bootout`, deletes the plist; the
# current label io.jobradar.ai-worker and the old one de.jobradar.ai-worker), on Linux the systemd user unit
# job-radar-ai-worker.service (`systemctl --user disable --now`, deletes the unit file). Leaves the logs.
#
#   scripts/ops/uninstall-ai-worker.sh [--purge-logs] [--root <checkout>]
#
#   --purge-logs     also delete the logs: data/logs/ai-worker.* and (macOS) ~/Library/Logs/job-radar/ai-worker.*
#                    (launchd's capture file, and the logs of earlier installs)
#   --root <path>    the product directory whose data/logs to purge (default: the MAIN checkout, like install-ai-worker.sh)
#
# AI requests queue up in the database while the worker is gone; /sources shows the worker as not responding.
set -euo pipefail

LABELS=("io.jobradar.ai-worker" "de.jobradar.ai-worker") # current label, then the one before the rename
DOMAIN="gui/$(id -u)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PURGE=0
ROOT=""

die() { echo "uninstall-ai-worker: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-logs) PURGE=1 ;;
    --root) [[ $# -ge 2 ]] || die "--root needs a path"; ROOT="$2"; shift ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

SYSTEMD_UNIT="job-radar-ai-worker.service"
UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SYSTEMD_UNIT"
IS_MAC=0
[[ "$(uname -s)" == "Darwin" ]] && IS_MAC=1

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

# Linux: the user unit. Nothing to do when its file is not there and no unit of that name is loaded.
SYSTEMD_PROBLEM=""
[[ "$IS_MAC" -eq 0 ]] && SYSTEMD_PROBLEM="$(systemd_user_problem)"
if [[ "$IS_MAC" -eq 0 && -n "$SYSTEMD_PROBLEM" ]]; then
  if [[ -f "$UNIT_FILE" ]]; then
    echo "uninstall-ai-worker: $UNIT_FILE exists, but the unit cannot be stopped: $SYSTEMD_PROBLEM." >&2
    echo "Nothing was removed; fix that and run this script again." >&2
    exit 1
  fi
  echo "no $SYSTEMD_UNIT installed ($UNIT_FILE does not exist)"
elif [[ "$IS_MAC" -eq 0 && ! -f "$UNIT_FILE" ]] && ! systemctl --user is-active "$SYSTEMD_UNIT" >/dev/null 2>&1 && ! systemctl --user is-enabled "$SYSTEMD_UNIT" >/dev/null 2>&1; then
  echo "no $SYSTEMD_UNIT installed ($UNIT_FILE does not exist)"
elif [[ "$IS_MAC" -eq 0 ]]; then
  if systemctl --user is-enabled "$SYSTEMD_UNIT" >/dev/null 2>&1 || systemctl --user is-active "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    systemctl --user disable --now "$SYSTEMD_UNIT" >/dev/null 2>&1 || systemctl --user stop "$SYSTEMD_UNIT" || true
    echo "stopped and disabled $SYSTEMD_UNIT"
  else
    echo "$SYSTEMD_UNIT was not enabled"
  fi
  if [[ -f "$UNIT_FILE" ]]; then
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload || true
    echo "removed $UNIT_FILE"
  fi
  if systemctl --user is-active "$SYSTEMD_UNIT" >/dev/null 2>&1; then
    echo "uninstall-ai-worker: $SYSTEMD_UNIT is still running" >&2
    exit 1
  fi
fi
if [[ "$IS_MAC" -eq 0 ]]; then
  if [[ "$PURGE" -eq 1 && -n "$ROOT" && -d "$ROOT/data/logs" ]]; then
    rm -f "$ROOT/data/logs/"ai-worker.*
    echo "removed the ai-worker logs under $ROOT/data/logs"
  elif [[ "$PURGE" -eq 1 ]]; then
    echo "pass --root <product directory> to purge the worker logs under data/logs"
  fi
  echo "uninstalled: no ai-worker unit is left"
  exit 0
fi

for LABEL in "${LABELS[@]}"; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    echo "stopped and unloaded $LABEL"
  else
    echo "$LABEL was not loaded"
  fi
  if [[ -f "$PLIST" ]]; then
    rm -f "$PLIST"
    echo "removed $PLIST"
  fi
done

if [[ "$PURGE" -eq 1 ]]; then
  # launchd's capture file and the logs of earlier installs (rotated copies included)
  rm -f "$HOME/Library/Logs/job-radar/"ai-worker.*
  echo "removed the ai-worker logs under ~/Library/Logs/job-radar"
  # the worker's own logs, in the main checkout (same lookup as install-ai-worker.sh)
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
  fi
  # Transitional: --root may still name a workspace checkout that holds the product in job-radar/.
  if [[ -n "$ROOT" && ! -f "$ROOT/package.json" && -f "$ROOT/job-radar/package.json" ]]; then ROOT="$ROOT/job-radar"; fi
  if [[ -n "$ROOT" && -d "$ROOT/data/logs" ]]; then
    rm -f "$ROOT/data/logs/"ai-worker.*
    echo "removed the ai-worker logs under $ROOT/data/logs"
  else
    echo "no data/logs found${ROOT:+ under $ROOT}; pass --root <product directory> to purge the worker logs"
  fi
fi

for LABEL in "${LABELS[@]}"; do
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "$LABEL" || [[ -f "$PLIST" ]]; then
    echo "uninstall-ai-worker: $LABEL is still present" >&2
    exit 1
  fi
done
echo "uninstalled: no ai-worker agent is loaded and the plists are gone"
