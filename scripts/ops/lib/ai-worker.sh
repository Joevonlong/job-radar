#!/usr/bin/env bash
# Stop and start the host ai-worker around a database restore. Sourced by scripts/ops/restore.sh (not run on its own).
#
#   ai_worker_stop    stops the agent / unit when it is running and remembers that, so that
#   ai_worker_start   starts it again only if ai_worker_stop stopped it
#
# macOS: the launchd agent whose label is `doctor.ai_worker_launchd_label` of schedule.yaml (default io.jobradar.ai-worker):
#        `launchctl bootout` / `launchctl bootstrap` with ~/Library/LaunchAgents/<label>.plist.
# Linux: the systemd user unit job-radar-ai-worker.service (`systemctl --user stop` / `start`).
# Nothing found (no agent, no unit, no systemctl): a loud notice and the restore goes on. That is safe: the restore terminates
# every connection to the old database before it swaps, so a worker that is still running reconnects to the restored
# database and never writes into the old one.
#
# Needs from the caller: $app (the checkout). Failing to stop or start never fails the restore.

AI_WORKER_SYSTEMD_UNIT="job-radar-ai-worker.service"
AI_WORKER_DEFAULT_LABEL="io.jobradar.ai-worker"
# What ai_worker_stop did: "", "launchd" or "systemd".
AI_WORKER_STOPPED_BY=""
AI_WORKER_LABEL_USED=""

ai_worker_label() {
  local schedule="$app/data/config/schedule.yaml" label=""
  [[ -f "$schedule" ]] || schedule="$app/config/schedule.yaml"
  label="$(awk '/^doctor:/ { in_doctor = 1; next } /^[^ #]/ { in_doctor = 0 } in_doctor && $1 == "ai_worker_launchd_label:" { gsub(/["'"'"']/, "", $2); print $2; exit }' "$schedule" 2>/dev/null || true)"
  printf '%s' "${label:-$AI_WORKER_DEFAULT_LABEL}"
}

ai_worker_notice() {
  echo "!!! ai-worker: $1" >&2
  echo "!!! Stop the ai-worker yourself if one is running (macOS: scripts/ops/uninstall-ai-worker.sh; Linux: systemctl --user stop $AI_WORKER_SYSTEMD_UNIT)." >&2
  echo "!!! The restore continues: connections to the old database are terminated before the swap, so a worker that stays up reconnects to the restored database." >&2
}

ai_worker_stop() {
  AI_WORKER_STOPPED_BY=""
  case "$(uname -s)" in
    Darwin)
      local label domain
      label="$(ai_worker_label)"
      domain="gui/$(id -u)"
      if ! command -v launchctl >/dev/null 2>&1; then
        ai_worker_notice "launchctl not found"
        return 0
      fi
      if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
        echo "ai-worker: no launchd agent '$label' is loaded; nothing to stop"
        return 0
      fi
      echo "== stopping the ai-worker (launchd agent $label)"
      if launchctl bootout "$domain/$label" 2>/dev/null; then
        local _
        for _ in $(seq 1 40); do launchctl print "$domain/$label" >/dev/null 2>&1 || break; sleep 0.5; done
        AI_WORKER_STOPPED_BY="launchd"
        AI_WORKER_LABEL_USED="$label"
      else
        ai_worker_notice "could not stop the launchd agent '$label'"
      fi
      ;;
    *)
      if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user cat "$AI_WORKER_SYSTEMD_UNIT" >/dev/null 2>&1; then
        ai_worker_notice "no systemd user unit $AI_WORKER_SYSTEMD_UNIT found"
        return 0
      fi
      if ! systemctl --user is-active --quiet "$AI_WORKER_SYSTEMD_UNIT"; then
        echo "ai-worker: $AI_WORKER_SYSTEMD_UNIT is not running; nothing to stop"
        return 0
      fi
      echo "== stopping the ai-worker ($AI_WORKER_SYSTEMD_UNIT)"
      if systemctl --user stop "$AI_WORKER_SYSTEMD_UNIT"; then
        AI_WORKER_STOPPED_BY="systemd"
      else
        ai_worker_notice "could not stop $AI_WORKER_SYSTEMD_UNIT"
      fi
      ;;
  esac
  return 0
}

ai_worker_start() {
  case "$AI_WORKER_STOPPED_BY" in
    launchd)
      local plist="$HOME/Library/LaunchAgents/$AI_WORKER_LABEL_USED.plist"
      echo "== starting the ai-worker (launchd agent $AI_WORKER_LABEL_USED)"
      if [[ -f "$plist" ]] && launchctl bootstrap "gui/$(id -u)" "$plist"; then
        :
      else
        echo "warning: could not start the ai-worker; run scripts/ops/install-ai-worker.sh" >&2
      fi
      ;;
    systemd)
      echo "== starting the ai-worker ($AI_WORKER_SYSTEMD_UNIT)"
      systemctl --user start "$AI_WORKER_SYSTEMD_UNIT" || echo "warning: could not start the ai-worker; run: systemctl --user start $AI_WORKER_SYSTEMD_UNIT" >&2
      ;;
  esac
  AI_WORKER_STOPPED_BY=""
  return 0
}
