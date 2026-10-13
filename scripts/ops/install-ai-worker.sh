#!/usr/bin/env bash
# Install the host AI worker as a service of the user: a launchd agent on macOS, a systemd user unit on Linux.
#
#   scripts/ops/install-ai-worker.sh [--dry-run] [--root <checkout>] [--database-url <url>]
#
# The worker is a plain Node process (`tsx src/ai-worker/index.ts`) that runs the AI work with the logins of the
# local `claude` / `codex` CLIs, so the containers need no AI credential. This script writes
# ~/Library/LaunchAgents/io.jobradar.ai-worker.plist (KeepAlive), loads it with `launchctl bootstrap gui/$(id -u)` and
# checks it with `launchctl print`. Safe to run again: it replaces the loaded agent. An agent installed under the old label
# de.jobradar.ai-worker is booted out and its plist removed first (automatic migration). Undo with scripts/ops/uninstall-ai-worker.sh.
#
# Linux: renders scripts/ops/systemd/job-radar-ai-worker.service into ~/.config/systemd/user/ (mode 0600), then
# `systemctl --user daemon-reload` and `systemctl --user enable --now job-radar-ai-worker.service` (restart when it runs).
# For it to run while you are logged out: `loginctl enable-linger $USER` (printed, not run). Without a systemd user manager
# (or with JOB_RADAR_SERVICE_MANAGER=none) the script prints how to start the worker by hand and exits 0.
# JOB_RADAR_SERVICE_MANAGER=launchd|systemd|none overrides the detection.
#
# Logs: the worker writes data/logs/ai-worker.{out,err}.log itself and rotates
# them (ai.yaml host_worker.log_max_mb / log_keep). launchd's own capture file ~/Library/Logs/job-radar/ai-worker.launchd.log
# only gets what is printed before the worker opened its files, and crashes. Logs an earlier install left in
# ~/Library/Logs/job-radar/ are moved next to the new ones once.
#
#   --dry-run          print the plist and the commands, change nothing
#   --root <path>      the product directory the agent starts from (default: the MAIN checkout of this repository, even
#                      when the script is run from a git worktree)
#   --database-url <u> DATABASE_URL for the worker (default: $DATABASE_URL, else DATABASE_URL / POSTGRES_* in
#                      .env, else postgres://jobradar:jobradar@127.0.0.1:5433/jobradar)
#
# Paths of node, claude, codex and pnpm are detected now and written into the plist as absolute paths / PATH
# entries (launchd starts agents with a minimal PATH). Run it again after upgrading node or moving `claude`.
set -euo pipefail

LABEL="io.jobradar.ai-worker"
LEGACY_LABEL="de.jobradar.ai-worker" # the label before the rename; its agent is migrated away below
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LEGACY_PLIST="$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
DOMAIN="gui/$(id -u)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

DRY_RUN=0
ROOT=""
DATABASE_URL_ARG=""

# The header comment above (line 2 up to the first line that is not a comment); tests/ops/script-help.test.ts checks it names every option.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
die() { echo "install-ai-worker: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --root) [[ $# -ge 2 ]] || die "--root needs a path"; ROOT="$2"; shift ;;
    --database-url) [[ $# -ge 2 ]] || die "--database-url needs a value"; DATABASE_URL_ARG="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# ---- service manager: launchd (macOS), systemd user unit (Linux), or none ---------------------------------
SYSTEMD_UNIT="job-radar-ai-worker.service"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MANAGER="${JOB_RADAR_SERVICE_MANAGER:-}"
NO_SYSTEMD_REASON=""
# Why there is no usable systemd user manager (empty when there is one).
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
if [[ -z "$MANAGER" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then MANAGER="launchd"
  else
    NO_SYSTEMD_REASON="$(systemd_user_problem)"
    if [[ -z "$NO_SYSTEMD_REASON" ]]; then MANAGER="systemd"; else MANAGER="none"; fi
  fi
fi
case "$MANAGER" in
  launchd) [[ "$(uname -s)" == "Darwin" || "$DRY_RUN" -eq 1 ]] || die "launchd exists on macOS only" ;;
  systemd|none) ;;
  *) die "JOB_RADAR_SERVICE_MANAGER must be launchd, systemd or none, got '$MANAGER'" ;;
esac
if [[ "$MANAGER" == "none" ]]; then
  echo "install-ai-worker: no service manager found (neither launchd nor a systemd user manager): nothing installed."
  [[ -n "$NO_SYSTEMD_REASON" ]] && echo "Why no systemd user manager: $NO_SYSTEMD_REASON."
  echo "Start the worker yourself and keep it running, from the checkout: pnpm ai-worker"
  echo "(docs/host-setup.md, section 6b; on Linux with systemd, see scripts/ops/systemd/$SYSTEMD_UNIT)"
  exit 0
fi

# ---- the checkout the agent starts from: the main checkout, not a worktree -----------------------------
if [[ -z "$ROOT" ]]; then
  # This script lives in <product>/scripts/ops. The product is the git root, or a sub-directory of it (a workspace repository
  # that nests it); the main checkout holds the same path.
  product="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
  top="$(git -C "$product" rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git checkout; pass --root"
  top="$(cd "$top" && pwd -P)"
  common="$(git -C "$product" rev-parse --git-common-dir 2>/dev/null)"
  [[ "$common" = /* ]] || common="$product/$common"
  common="$(cd "$common" && pwd -P)"
  [[ "$(basename "$common")" == ".git" ]] || die "cannot find the main checkout from $common; pass --root"
  ROOT="$(dirname "$common")${product#"$top"}"
fi
ROOT="$(cd "$ROOT" && pwd -P)"
# Transitional: --root may still name a workspace checkout that holds the product in job-radar/.
if [[ ! -f "$ROOT/package.json" && -f "$ROOT/job-radar/package.json" ]]; then ROOT="$ROOT/job-radar"; fi
APP_DIR="$ROOT"
# node loads tsx as a loader (`node --import <tsx>`), NOT through the `tsx` CLI: the CLI is a parent process that spawns the
# real worker and relays signals; when it exited before its child, launchd saw the job gone, started a second worker and the first
# one lived on as an orphan. Now the process launchd tracks IS the worker.
TSX_LOADER="file://$APP_DIR/node_modules/tsx/dist/loader.mjs"
ENTRY="src/ai-worker/index.ts"
# CONSTRAINT: StandardOutPath / StandardErrorPath must NOT be on an external volume. launchd opens
# those files itself and cannot open a file there: the agent never starts ("last exit code = 78: EX_CONFIG"), with
# /bin/sh and with node alike. WorkingDirectory and the program files on the volume are fine, and the node process launchd
# starts can write there. So the worker gets `--log-dir` and writes its own logs on the external volume (data/ is gitignored)...
LOG_DIR="$APP_DIR/data/logs"
# ... and launchd's capture file stays on the internal disk: small (start-up output and crashes); the worker rotates it by
# size (ai.yaml host_worker.log_max_mb / log_keep) and moves the rotated copies to $LOG_DIR.
LAUNCHD_LOG_DIR="$HOME/Library/Logs/job-radar"
LAUNCHD_LOG="$LAUNCHD_LOG_DIR/ai-worker.launchd.log"
# The config layers, written out explicitly (the same as the code's defaults and compose.yaml's mounts), so the
# worker reads exactly what the web writes: shipped defaults, the user's config (wins), the profile.
DEFAULTS_DIR="$APP_DIR/config"
USER_CONFIG_DIR="$APP_DIR/data/config"
PROFILE_DIR="$APP_DIR/data/profile"
# What launchd wrote in earlier versions, moved next to the new logs once.
OLD_LOGS=(ai-worker.out.log ai-worker.err.log)

[[ -f "$APP_DIR/package.json" ]] || die "$APP_DIR/package.json not found"
[[ -f "$APP_DIR/$ENTRY" ]] || die "$APP_DIR/$ENTRY not found: is this a complete checkout?"
[[ -f "${TSX_LOADER#file://}" ]] || die "${TSX_LOADER#file://} not found: run 'pnpm install' in $APP_DIR first"

# ---- binaries -----------------------------------------------------------------------------------------
NODE_BIN="$(command -v node || true)"; [[ -n "$NODE_BIN" ]] || die "node is not on PATH"
CLAUDE_BIN="$(command -v claude || true)"
CODEX_BIN="$(command -v codex || true)"
PNPM_BIN="$(command -v pnpm || true)"
[[ -n "$CLAUDE_BIN" ]] || echo "warning: claude is not on PATH: the claude-cli provider will be unavailable" >&2
[[ -n "$CODEX_BIN" ]] || echo "warning: codex is not on PATH: the codex-cli provider will be unavailable" >&2

AGENT_PATH=""
add_path() { [[ -n "$1" && ":$AGENT_PATH:" != *":$1:"* ]] && AGENT_PATH="${AGENT_PATH:+$AGENT_PATH:}$1"; return 0; }
for bin in "$NODE_BIN" "$CLAUDE_BIN" "$CODEX_BIN" "$PNPM_BIN"; do [[ -n "$bin" ]] && add_path "$(dirname "$bin")"; done
for dir in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_path "$dir"; done

# ---- DATABASE_URL (never printed in full) ---------------------------------------------------------------
env_value() { # env_value KEY -> value from .env (first match, quotes stripped), or empty
  local file="$APP_DIR/.env"
  [[ -f "$file" ]] || return 0
  grep -E "^[[:space:]]*$1=" "$file" | head -n1 | sed -E "s/^[[:space:]]*$1=//; s/^['\"]//; s/['\"][[:space:]]*\$//" || true
}
DB_URL="$DATABASE_URL_ARG"
[[ -n "$DB_URL" ]] || DB_URL="${DATABASE_URL:-}"
[[ -n "$DB_URL" ]] || DB_URL="$(env_value DATABASE_URL)"
if [[ -z "$DB_URL" ]]; then
  db_user="$(env_value POSTGRES_USER)"; db_pass="$(env_value POSTGRES_PASSWORD)"; db_name="$(env_value POSTGRES_DB)"; db_port="$(env_value DB_HOST_PORT)"
  DB_URL="postgres://${db_user:-jobradar}:${db_pass:-jobradar}@127.0.0.1:${db_port:-5433}/${db_name:-jobradar}"
fi
[[ "$DB_URL" =~ ^postgres(ql)?:// ]] || die "DATABASE_URL must be a postgres:// URL"
mask_url() { echo "$1" | sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#'; }

xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }

render_plist() { # render_plist <database url to write>
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>
    <string>--import</string>
    <string>$(xml "$TSX_LOADER")</string>
    <string>--env-file-if-exists=.env</string>
    <string>$ENTRY</string>
    <string>--log-dir</string>
    <string>$(xml "$LOG_DIR")</string>
    <string>--launchd-log</string>
    <string>$(xml "$LAUNCHD_LOG")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$APP_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$AGENT_PATH")</string>
    <key>DATABASE_URL</key>
    <string>$(xml "$1")</string>
    <key>JOB_RADAR_DEFAULTS_DIR</key>
    <string>$(xml "$DEFAULTS_DIR")</string>
    <key>JOB_RADAR_CONFIG_DIR</key>
    <string>$(xml "$USER_CONFIG_DIR")</string>
    <key>JOB_RADAR_PROFILE_DIR</key>
    <string>$(xml "$PROFILE_DIR")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml "$LAUNCHD_LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LAUNCHD_LOG")</string>
</dict>
</plist>
PLIST
}

# ---- Linux: the systemd user unit -------------------------------------------------------------------------
# Values for the unit file, escaped per setting (systemd.syntax / systemd.exec):
#   sd_path  WorkingDirectory= takes the rest of the line as the path, unquoted: only the `%` specifier is escaped
#   sd_env   a double-quoted Environment= value: backslash, quote and `%` escaped (`$` is literal there)
#   sd_exec  a double-quoted ExecStart= argument: as sd_env, plus `$` (ExecStart expands $VAR)
sd_path() { local v="$1"; v="${v//%/%%}"; printf '%s' "$v"; }
sd_env() { local v="$1"; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//%/%%}"; printf '%s' "$v"; }
sd_exec() { local v; v="$(sd_env "$1")"; v="${v//\$/\$\$}"; printf '%s' "$v"; }
render_unit() { # render_unit <database url to write>
  local text key value
  # bash 5.2 would read `&` in a replacement as "the matched text"; values are paths and a URL, taken literally
  shopt -u patsub_replacement 2>/dev/null || true
  text="$(<"$SCRIPT_DIR/systemd/$SYSTEMD_UNIT")"
  for key in APP_DIR NODE_BIN TSX_LOADER LOG_DIR PATH DATABASE_URL DEFAULTS_DIR USER_CONFIG_DIR PROFILE_DIR; do
    case "$key" in
      PATH) value="$AGENT_PATH" ;;
      DATABASE_URL) value="$1" ;;
      *) value="${!key}" ;;
    esac
    [[ "$value" != *$'\n'* ]] || die "$key contains a line break: cannot write it into a systemd unit"
    case "$key" in
      APP_DIR) value="$(sd_path "$value")" ;;
      NODE_BIN | TSX_LOADER | LOG_DIR) value="$(sd_exec "$value")" ;;
      *) value="$(sd_env "$value")" ;;
    esac
    text="${text//@$key@/$value}"
  done
  printf '%s\n' "$text"
}

if [[ "$MANAGER" == "systemd" ]]; then
  UNIT_FILE="$SYSTEMD_DIR/$SYSTEMD_UNIT"
  echo "unit:      $UNIT_FILE"
  echo "checkout:  $ROOT"
  echo "node:      $NODE_BIN"
  echo "claude:    ${CLAUDE_BIN:-NOT FOUND}"
  echo "codex:     ${CODEX_BIN:-NOT FOUND}"
  echo "database:  $(mask_url "$DB_URL")"
  echo "logs:      $LOG_DIR/ai-worker.{out,err}.log (start-up failures and crashes: journalctl --user -u $SYSTEMD_UNIT)"
  echo "config:    $USER_CONFIG_DIR (over the defaults in $DEFAULTS_DIR)"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo
    echo "--- unit (dry run: nothing is written or started; the password is masked) ---"
    render_unit "$(mask_url "$DB_URL")"
    echo "--- would run ---"
    echo "mkdir -p $LOG_DIR $SYSTEMD_DIR"
    echo "install -m 600 <unit> $UNIT_FILE"
    echo "systemctl --user daemon-reload"
    echo "systemctl --user enable $SYSTEMD_UNIT"
    echo "systemctl --user restart $SYSTEMD_UNIT"
    echo "systemctl --user is-active $SYSTEMD_UNIT"
    exit 0
  fi
  mkdir -p "$LOG_DIR" "$SYSTEMD_DIR"
  tmp="$(mktemp "${TMPDIR:-/tmp}/$SYSTEMD_UNIT.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  chmod 600 "$tmp"
  render_unit "$DB_URL" > "$tmp"
  mv "$tmp" "$UNIT_FILE"
  trap - EXIT
  chmod 600 "$UNIT_FILE"
  systemctl --user daemon-reload
  systemctl --user enable "$SYSTEMD_UNIT" >/dev/null
  # restart: a running worker picks up the new unit (its running AI request goes back to the queue, nothing is lost)
  systemctl --user restart "$SYSTEMD_UNIT"
  state=""
  for _ in $(seq 1 20); do
    state="$(systemctl --user is-active "$SYSTEMD_UNIT" 2>/dev/null || true)"
    [[ "$state" == "active" ]] && break
    sleep 0.5
  done
  if [[ "$state" != "active" ]]; then
    echo "install-ai-worker: installed, but $SYSTEMD_UNIT is not running (state: ${state:-unknown}). Last log lines:" >&2
    journalctl --user -u "$SYSTEMD_UNIT" -n 15 --no-pager >&2 2>/dev/null || true
    tail -n 15 "$LOG_DIR/ai-worker.err.log" 2>/dev/null >&2 || true
    exit 1
  fi
  if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
    echo "note: the worker stops when you log out. To keep it running: loginctl enable-linger $(id -un)"
  fi
  echo "installed: $SYSTEMD_UNIT is running (systemctl --user status $SYSTEMD_UNIT)"
  exit 0
fi

echo "label:     $LABEL"
echo "plist:     $PLIST"
echo "checkout:  $ROOT"
echo "node:      $NODE_BIN"
echo "claude:    ${CLAUDE_BIN:-NOT FOUND}"
echo "codex:     ${CODEX_BIN:-NOT FOUND}"
echo "database:  $(mask_url "$DB_URL")"
echo "logs:      $LOG_DIR/ai-worker.{out,err}.log (start-up failures and crashes: $LAUNCHD_LOG)"
echo "config:    $USER_CONFIG_DIR (over the defaults in $DEFAULTS_DIR)"

# migrate_old_logs: move what earlier versions left in launchd's capture directory next to the new logs, once. Idempotent: a moved
# file is gone, so a second run has nothing to do; should it find one again, it is appended to the same target.
migrate_old_logs() {
  local name old target
  for name in "${OLD_LOGS[@]}"; do
    old="$LAUNCHD_LOG_DIR/$name"
    [[ -f "$old" ]] || continue
    target="$LOG_DIR/${name%.log}.before-upgrade.log"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "cat $old >> $target && rm $old   # move the old log to the external volume"
    elif cat "$old" >> "$target" && rm -f "$old"; then
      echo "moved $old -> $target"
    else
      echo "warning: could not move $old to $target; it stays where it is" >&2
    fi
  done
}

# Migration from the old label, in three steps so that a failed install never leaves the machine without an agent:
#   stop_legacy_agent   boot out the old agent and wait until it is gone (two workers never run together); keeps its plist
#   rollback_legacy     the new bootstrap failed: bootstrap the old plist again
#   remove_legacy_plist the new agent is bootstrapped: delete the old plist
# Idempotent: with nothing under the old label all three do nothing.
LEGACY_STOPPED=0
stop_legacy_agent() {
  local loaded=0
  launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 && loaded=1
  if [[ "$loaded" -eq 0 && ! -f "$LEGACY_PLIST" ]]; then return 0; fi
  echo "migration: found the old agent $LEGACY_LABEL"
  if [[ "$loaded" -eq 1 ]]; then
    launchctl bootout "$DOMAIN/$LEGACY_LABEL" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    LEGACY_STOPPED=1
    if launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1; then
      # never start the new agent next to a still-running old one
      die "the old agent $LEGACY_LABEL is still loaded after bootout; stop it by hand (launchctl bootout $DOMAIN/$LEGACY_LABEL) and run again"
    fi
    echo "migration: unloaded $LEGACY_LABEL"
  fi
}
rollback_legacy() {
  [[ "$LEGACY_STOPPED" -eq 1 && -f "$LEGACY_PLIST" ]] || return 0
  if launchctl bootstrap "$DOMAIN" "$LEGACY_PLIST"; then echo "migration: rolled back, the old agent $LEGACY_LABEL is loaded again" >&2
  else echo "migration: rollback failed too: load it by hand with launchctl bootstrap $DOMAIN $LEGACY_PLIST" >&2; fi
}
remove_legacy_plist() {
  if [[ -f "$LEGACY_PLIST" ]]; then
    rm -f "$LEGACY_PLIST"
    echo "migration: removed $LEGACY_PLIST"
  fi
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  echo "--- plist (dry run: nothing is written or loaded; the password is masked) ---"
  render_plist "$(mask_url "$DB_URL")"
  echo "--- would run ---"
  echo "mkdir -p $LOG_DIR $LAUNCHD_LOG_DIR"
  if launchctl print "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 || [[ -f "$LEGACY_PLIST" ]]; then
    echo "launchctl bootout $DOMAIN/$LEGACY_LABEL && rm $LEGACY_PLIST   # migration: the old label de.jobradar.ai-worker"
  fi
  echo "launchctl bootout $DOMAIN/$LABEL   # only when already loaded"
  migrate_old_logs
  echo "launchctl bootstrap $DOMAIN $PLIST"
  echo "launchctl print $DOMAIN/$LABEL"
  exit 0
fi

mkdir -p "$LOG_DIR" "$LAUNCHD_LOG_DIR" "$(dirname "$PLIST")"
tmp="$(mktemp "${TMPDIR:-/tmp}/$LABEL.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
render_plist "$DB_URL" > "$tmp"
plutil -lint "$tmp" >/dev/null || die "the generated plist is not valid"
chmod 600 "$tmp"

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "already loaded: replacing it"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
fi
stop_legacy_agent # the new plist is written and valid (above); only now is the old agent stopped
migrate_old_logs # the old agent is stopped now, nothing writes them any more
mv "$tmp" "$PLIST"
trap - EXIT
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  echo "install-ai-worker: launchctl bootstrap of $LABEL failed" >&2
  rollback_legacy
  rm -f "$PLIST"
  exit 1
fi
remove_legacy_plist
launchctl enable "$DOMAIN/$LABEL"

state=""
for _ in $(seq 1 20); do
  out="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null || true)"
  state="$(echo "$out" | sed -n 's/^[[:space:]]*state = //p' | head -n1)"
  [[ "$state" == "running" ]] && break
  sleep 0.5
done
echo
launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|pid|program|path|working directory|stdout path|last exit code) " || true
if [[ "$state" != "running" ]]; then
  echo "install-ai-worker: loaded, but the agent is not running (state: ${state:-unknown}). Last log lines:" >&2
  for file in "$LAUNCHD_LOG" "$LOG_DIR/ai-worker.err.log"; do
    echo "--- $file ---" >&2
    tail -n 15 "$file" 2>/dev/null >&2 || true
  done
  exit 1
fi
sleep 2
echo "--- $LOG_DIR/ai-worker.out.log (tail) ---"
tail -n 8 "$LOG_DIR/ai-worker.out.log" 2>/dev/null || true
echo "installed: $LABEL is running ($(launchctl list | awk -v l="$LABEL" '$3 == l { print "pid " $1 ", last exit " $2 }'))"
