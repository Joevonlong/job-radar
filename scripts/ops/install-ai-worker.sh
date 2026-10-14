#!/usr/bin/env bash
# Install the host AI worker as a service of the user, run from a read-only release directory: a launchd agent on macOS,
# a systemd user unit on Linux.
#
#   scripts/ops/install-ai-worker.sh [--release <dir>] [--root <main>] [--database-url <url>] [--dry-run]
#   scripts/ops/install-ai-worker.sh --print-release [--root <main>]
#
# The worker is a plain Node process (`node --import <tsx loader> src/ai-worker/index.ts`) that runs the AI work with the
# logins of the local `claude` / `codex` CLIs, so the containers need no AI credential. Its code comes only from the
# release directory <main>/data/releases/ai-worker/<sha>/ (scripts/ops/prepare-release.sh); everything of the user
# (.env, data/config, data/profile, data/logs) comes from the main checkout <main>. Every path in the definition is
# absolute.
#
#   --release <dir>     the release to run: <main>/data/releases/ai-worker/<40 hex>, not a symbolic link, with a valid
#                       .release.json. Without it, prepare-release.sh builds (or reuses) the release of HEAD first.
#   --root <main>       the main checkout (default: the MAIN checkout of this repository, even when the script is run
#                       from a git worktree)
#   --database-url <u>  DATABASE_URL for the worker (default: $DATABASE_URL, else DATABASE_URL / POSTGRES_* in .env,
#                       else postgres://jobradar:jobradar@127.0.0.1:5433/jobradar)
#   --dry-run           print the definition and the commands, change nothing
#   --print-release     print the release directory the installed worker runs from, read from its definition file only
#                       (no launchctl, systemctl or node): exit 0 and one absolute path; 3 = not installed, or only under
#                       the old label de.jobradar.ai-worker; 4 = installed, but not from a release directory (the path goes
#                       to stderr); 1 = it cannot be read, or the service identity is ambiguous
#   -h, --help          print this help
#
# The switch (the old worker is replaced only when the new one is proven ready), under the release lock
# data/releases/ai-worker/.lock (taken here, or re-entered with the token of a calling deploy.sh):
#   1  checks: one service definition at most (the label rules of scripts/ops/lib/ai-worker.sh), no unresolved backup
#      data/run/ai-worker-swap-backup/, the database clock readable, the enable state recordable, the installed
#      definition's DATABASE_URL readable
#   2  backup: the installed definition and a state file into data/run/ai-worker-swap-backup/ (never overwritten)
#   3  the new definition, rendered to a temporary file (launchd: checked with plutil -lint)
#   4  stop the old worker (launchctl bootout / systemctl --user stop) and wait until it is gone
#   5  install the new definition under the configured label (launchd: enable, bootstrap; systemd: daemon-reload, enable,
#      start); a definition under the default or the old label is removed now (its copy is in the backup)
#   6  wait for evidence: a new PID that holds the worker's instance lock and wrote a heartbeat since step 1
#   7  on any failure: stop the new worker, remove its definition, put the old one back as it was (loaded, running, enable
#      state of both labels) and wait for evidence of it again
#   8  on success: remove old releases (deploy.ai_worker_releases_keep in total; never the new one or the previous one),
#      then the backup
# Waits are bounded by deploy.ai_worker_swap_timeout_seconds; the definition's stop timeout (launchd ExitTimeOut,
# systemd TimeoutStopSec) is deploy.ai_worker_stop_timeout_seconds (schedule.yaml).
#
# Exit code: 0 = the new worker is ready. 1, with the first word of the message saying where it stopped:
#   not changed:      refused before anything was changed (lock held, unresolved backup, ambiguous identity, database
#                     unreachable, a definition URL that cannot be read, invalid release, Node version, enable state)
#   rolled back:      the previous state is back and checked
#   ROLLBACK FAILED:  the previous state could not be restored; the message has the state, the backup and what to do
# Interrupted (INT, TERM, HUP): the switch rolls back (or, once the new worker is ready, only skips the clean-up), every
# process group the script started has ended, then it exits 130, 143 or 129.
#
# Linux: the unit is rendered from scripts/ops/systemd/job-radar-ai-worker.service into ~/.config/systemd/user/ (mode
# 0600). For it to run while you are logged out: `loginctl enable-linger $USER` (printed, not run). Without a systemd
# user manager (or with JOB_RADAR_SERVICE_MANAGER=none) the script prints how to start the worker by hand and exits 0.
# JOB_RADAR_SERVICE_MANAGER=launchd|systemd|none overrides the detection.
#
# Logs: the worker writes data/logs/ai-worker.{out,err}.log itself and rotates them (ai.yaml host_worker.log_max_mb /
# log_keep). launchd's own capture file ~/Library/Logs/job-radar/ai-worker.launchd.log only gets what is printed before
# the worker opened its files, and crashes.
#
# Paths of node, claude, codex and pnpm are detected now and written into the definition as absolute paths / PATH
# entries (launchd starts agents with a minimal PATH). Run it again after upgrading node or moving `claude`.
#
# capability: ai-worker-release-dir
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

DRY_RUN=0
PRINT_RELEASE=0
ROOT=""
RELEASE_ARG=""
DATABASE_URL_ARG=""

# The header comment above (line 2 up to the first line that is not a comment); tests/ops/script-help.test.ts checks it names every option.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
# Every refusal before the switch changed anything starts with "not changed:" (exit 1).
not_changed() { echo "not changed: install-ai-worker: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --print-release) PRINT_RELEASE=1 ;;
    --root) [[ $# -ge 2 ]] || not_changed "--root needs a path"; ROOT="$2"; shift ;;
    --release) [[ $# -ge 2 && -n "$2" ]] || not_changed "--release needs a directory"; RELEASE_ARG="$2"; shift ;;
    --database-url) [[ $# -ge 2 ]] || not_changed "--database-url needs a value"; DATABASE_URL_ARG="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) not_changed "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# shellcheck source=lib/ai-worker.sh
source "$SCRIPT_DIR/lib/ai-worker.sh"

# ---- the main checkout: never a worktree ----------------------------------------------------------------------------
if [[ -z "$ROOT" ]]; then
  # This script lives in <product>/scripts/ops. The product is the git root, or a sub-directory of it (a workspace
  # repository that nests it); the main checkout holds the same path.
  product="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
  top="$(git -C "$product" rev-parse --show-toplevel 2>/dev/null)" || not_changed "not inside a git checkout; pass --root"
  top="$(cd "$top" && pwd -P)"
  common="$(git -C "$product" rev-parse --git-common-dir 2>/dev/null)"
  [[ "$common" = /* ]] || common="$product/$common"
  common="$(cd "$common" && pwd -P)"
  [[ "$(basename "$common")" == ".git" ]] || not_changed "cannot find the main checkout from $common; pass --root"
  ROOT="$(dirname "$common")${product#"$top"}"
fi
ROOT="$(cd "$ROOT" 2>/dev/null && pwd -P)" || not_changed "--root: no such directory"
# Transitional: --root may still name a workspace checkout that holds the product in job-radar/.
if [[ ! -f "$ROOT/package.json" && -f "$ROOT/job-radar/package.json" ]]; then ROOT="$ROOT/job-radar"; fi
MAIN_DIR="$ROOT"
RELEASES_PARENT="$MAIN_DIR/data/releases/ai-worker"

ident_value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1; }   # ident_value <ai_worker_identity output> <key>

# release_dir_of <path>: 0 when <path> is <main>/data/releases/ai-worker/<40 hex> (as a string; nothing is resolved).
release_dir_of() { [[ "$1" == "$RELEASES_PARENT/"* && "${1#"$RELEASES_PARENT/"}" =~ ^[0-9a-f]{40}$ ]]; }

# ---- --print-release: files only, before any service manager or node check ----------------------------------------
# print_release: prints the release directory of the installed definition and returns 0, or returns 3 / 4 / 1 (header).
print_release() {
  local ident origin def platform wd n line
  ident="$(ai_worker_identity "$MAIN_DIR")" || { echo "install-ai-worker: the ai-worker service identity is ambiguous (see above)" >&2; return 1; }
  origin="$(ident_value "$ident" origin)"
  def="$(ident_value "$ident" found_definition)"
  platform="$(ident_value "$ident" platform)"
  case "$origin" in
    none) echo "install-ai-worker: no ai-worker is installed" >&2; return 3 ;;
    legacy) echo "install-ai-worker: only a definition under the old label $AI_WORKER_LEGACY_LABEL is installed ($def); it does not run from a release" >&2; return 3 ;;
    resolved|default) ;;
    *) echo "install-ai-worker: unexpected identity origin '$origin'" >&2; return 1 ;;
  esac
  [[ -f "$def" && -r "$def" ]] || { echo "install-ai-worker: cannot read $def" >&2; return 1; }
  if [[ "$platform" == launchd ]]; then
    wd="$(plutil -extract WorkingDirectory raw -o - "$def" 2>/dev/null)" || { echo "install-ai-worker: cannot read WorkingDirectory from $def" >&2; return 1; }
    wd="${wd%$'\n'}"
  else
    n="$(grep -c '^WorkingDirectory=' "$def" 2>/dev/null)" || n=0
    [[ "$n" == 1 ]] || { echo "install-ai-worker: $def must set WorkingDirectory= exactly once (found $n)" >&2; return 1; }
    line="$(grep '^WorkingDirectory=' "$def")" || return 1
    wd="$(sd_path_decode "${line#WorkingDirectory=}")" || { echo "install-ai-worker: cannot decode WorkingDirectory= of $def (a % sequence the install script never writes)" >&2; return 1; }
  fi
  if [[ "$wd" == /* && "$wd" != *$'\n'* ]] && release_dir_of "$wd"; then
    printf '%s\n' "$wd"
    return 0
  fi
  echo "install-ai-worker: the installed worker does not run from a release directory: $wd" >&2
  return 4
}
if [[ "$PRINT_RELEASE" -eq 1 ]]; then
  prc=0; print_release || prc=$?
  exit "$prc"
fi

# shellcheck source=lib/proc.sh
source "$SCRIPT_DIR/lib/proc.sh"
PROC_RC_ALLOWED="0 1 2"
# shellcheck source=lib/releases.sh
source "$SCRIPT_DIR/lib/releases.sh"

# ---- service manager: launchd (macOS), systemd user unit (Linux), or none -----------------------------------------
SYSTEMD_UNIT="$AI_WORKER_SYSTEMD_UNIT"
MANAGER="${JOB_RADAR_SERVICE_MANAGER:-}"
MANAGER_FORCED="$MANAGER"
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
  # launchd exists on macOS only; an explicit JOB_RADAR_SERVICE_MANAGER=launchd is taken as it is (the tests' simulator)
  launchd) [[ "$(uname -s)" == "Darwin" || "$DRY_RUN" -eq 1 || "$MANAGER_FORCED" == launchd ]] || not_changed "launchd exists on macOS only" ;;
  systemd|none) ;;
  *) not_changed "JOB_RADAR_SERVICE_MANAGER must be launchd, systemd or none, got '$MANAGER'" ;;
esac
if [[ "$MANAGER" == "none" ]]; then
  echo "install-ai-worker: no service manager found (neither launchd nor a systemd user manager): nothing installed."
  [[ -n "$NO_SYSTEMD_REASON" ]] && echo "Why no systemd user manager: $NO_SYSTEMD_REASON."
  echo "Start the worker yourself and keep it running, from the checkout: pnpm ai-worker"
  echo "(docs/host-setup.md, section 6b; on Linux with systemd, see scripts/ops/systemd/$SYSTEMD_UNIT)"
  exit 0
fi
# The lib functions (identity, waits) and prepare-release.sh's --print-release call decide by the same manager.
export JOB_RADAR_SERVICE_MANAGER="$MANAGER"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# ---- settings, paths of the main checkout ---------------------------------------------------------------------------
ai_worker_deploy_settings "$MAIN_DIR"
STOP_TIMEOUT="$AI_WORKER_STOP_TIMEOUT"
SWAP_TIMEOUT="$AI_WORKER_SWAP_TIMEOUT"
RELEASES_KEEP="$AI_WORKER_RELEASES_KEEP"
ENV_FILE="$MAIN_DIR/.env"
# CONSTRAINT: StandardOutPath / StandardErrorPath must NOT be on an external volume. launchd opens those files itself and
# cannot open a file there: the agent never starts ("last exit code = 78: EX_CONFIG"). So the worker gets `--log-dir` and
# writes its own logs under the main checkout (data/ is gitignored), and launchd's small capture file stays on the
# internal disk.
LOG_DIR="$MAIN_DIR/data/logs"
LAUNCHD_LOG_DIR="$HOME/Library/Logs/job-radar"
LAUNCHD_LOG="$LAUNCHD_LOG_DIR/ai-worker.launchd.log"
USER_CONFIG_DIR="$MAIN_DIR/data/config"
PROFILE_DIR="$MAIN_DIR/data/profile"
BACKUP_DIR="$MAIN_DIR/data/run/ai-worker-swap-backup"

# ---- binaries -----------------------------------------------------------------------------------------------------
NODE_BIN="$(command -v node || true)"; [[ -n "$NODE_BIN" ]] || not_changed "node is not on PATH"
CLAUDE_BIN="$(command -v claude || true)"
CODEX_BIN="$(command -v codex || true)"
PNPM_BIN="$(command -v pnpm || true)"
[[ -n "$CLAUDE_BIN" ]] || echo "warning: claude is not on PATH: the claude-cli provider will be unavailable" >&2
[[ -n "$CODEX_BIN" ]] || echo "warning: codex is not on PATH: the codex-cli provider will be unavailable" >&2
AGENT_PATH=""
add_path() { [[ -n "$1" && ":$AGENT_PATH:" != *":$1:"* ]] && AGENT_PATH="${AGENT_PATH:+$AGENT_PATH:}$1"; return 0; }
for bin in "$NODE_BIN" "$CLAUDE_BIN" "$CODEX_BIN" "$PNPM_BIN"; do [[ -n "$bin" ]] && add_path "$(dirname "$bin")"; done
for dir in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_path "$dir"; done

# ---- DATABASE_URL (never printed in full) -------------------------------------------------------------------------
DB_URL="$(ai_worker_db_url "$MAIN_DIR" ${DATABASE_URL_ARG:+--database-url "$DATABASE_URL_ARG"})"
[[ "$DB_URL" =~ ^postgres(ql)?:// ]] || not_changed "DATABASE_URL must be a postgres:// URL"
mask_url() { echo "$1" | sed -E 's#(://[^:/@]*):[^@]*@#\1:***@#'; }

# ---- the release -------------------------------------------------------------------------------------------------
# --release: made absolute with cd -P; the argument itself must not be a symbolic link.
RELEASE_DIR=""
if [[ -n "$RELEASE_ARG" ]]; then
  [[ ! -L "${RELEASE_ARG%/}" ]] || not_changed "--release $RELEASE_ARG is a symbolic link"
  RELEASE_DIR="$(cd -P "$RELEASE_ARG" 2>/dev/null && pwd -P)" || not_changed "--release $RELEASE_ARG: no such directory"
  release_dir_of "$RELEASE_DIR" || not_changed "--release $RELEASE_DIR is not $RELEASES_PARENT/<40 hex sha>"
fi
HEAD_SHA=""
if [[ -z "$RELEASE_DIR" ]]; then
  HEAD_SHA="$(git -C "$MAIN_DIR" rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null)" || HEAD_SHA=""
  [[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ ]] || not_changed "cannot read HEAD of $MAIN_DIR; pass --release"
  RELEASE_DIR="$RELEASES_PARENT/$HEAD_SHA"
fi
RELEASE_SHA="${RELEASE_DIR##*/}"

# file_url <absolute path>: a file:// URL, percent-encoded by node (spaces, %, # and ? in the path stay a path).
file_url() { NODE_OPTIONS="" "$NODE_BIN" -e 'process.stdout.write(require("node:url").pathToFileURL(process.argv[1]).href)' "$1"; }

# set_release_paths: the code paths, all inside the release. The guard comes first, and only when the release has one
# (releases built before it do not).
set_release_paths() {
  TSX_LOADER_PATH="$RELEASE_DIR/node_modules/tsx/dist/loader.mjs"
  GUARD_PATH="$RELEASE_DIR/src/ai-worker/release-guard.mjs"
  ENTRY="$RELEASE_DIR/src/ai-worker/index.ts"
  DEFAULTS_DIR="$RELEASE_DIR/config"
  TSCONFIG="$RELEASE_DIR/tsconfig.json"
  TSX_LOADER="$(file_url "$TSX_LOADER_PATH")" || not_changed "cannot build the file URL of $TSX_LOADER_PATH"
  GUARD_URL=""
  if [[ -f "$GUARD_PATH" ]]; then GUARD_URL="$(file_url "$GUARD_PATH")" || not_changed "cannot build the file URL of $GUARD_PATH"; fi
}

xml() { local s="$1"; s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"; printf '%s' "$s"; }

render_plist() { # render_plist <label> <database url to write>
  local guard=""
  [[ -z "$GUARD_URL" ]] || guard="
    <string>--import</string>
    <string>$(xml "$GUARD_URL")</string>"
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml "$1")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE_BIN")</string>$guard
    <string>--import</string>
    <string>$(xml "$TSX_LOADER")</string>
    <string>--env-file-if-exists=$(xml "$ENV_FILE")</string>
    <string>$(xml "$ENTRY")</string>
    <string>--log-dir</string>
    <string>$(xml "$LOG_DIR")</string>
    <string>--launchd-log</string>
    <string>$(xml "$LAUNCHD_LOG")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$RELEASE_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$AGENT_PATH")</string>
    <key>DATABASE_URL</key>
    <string>$(xml "$2")</string>
    <key>NODE_OPTIONS</key>
    <string></string>
    <key>JOB_RADAR_DEFAULTS_DIR</key>
    <string>$(xml "$DEFAULTS_DIR")</string>
    <key>JOB_RADAR_CONFIG_DIR</key>
    <string>$(xml "$USER_CONFIG_DIR")</string>
    <key>JOB_RADAR_PROFILE_DIR</key>
    <string>$(xml "$PROFILE_DIR")</string>
    <key>JOB_RADAR_DATA_ROOT</key>
    <string>$(xml "$MAIN_DIR")</string>
    <key>TSX_TSCONFIG_PATH</key>
    <string>$(xml "$TSCONFIG")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>$STOP_TIMEOUT</integer>
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

# Values for the unit file, escaped per setting (systemd.syntax / systemd.exec); scripts/ops/lib/ai-worker.sh has the
# exact inverses (sd_path_decode, sd_env_decode, sd_exec_decode):
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
  for key in RELEASE_DIR NODE_BIN GUARD_IMPORT TSX_LOADER ENV_FILE ENTRY LOG_DIR STOP_TIMEOUT PATH DATABASE_URL \
             DEFAULTS_DIR USER_CONFIG_DIR PROFILE_DIR DATA_ROOT TSCONFIG; do
    case "$key" in
      PATH) value="$AGENT_PATH" ;;
      DATABASE_URL) value="$1" ;;
      DATA_ROOT) value="$MAIN_DIR" ;;
      GUARD_IMPORT) value="$GUARD_URL" ;;
      *) value="${!key}" ;;
    esac
    [[ "$value" != *$'\n'* ]] || not_changed "$key contains a line break: cannot write it into a systemd unit"
    case "$key" in
      RELEASE_DIR) value="$(sd_path "$value")" ;;
      GUARD_IMPORT) [[ -z "$value" ]] || value="--import \"$(sd_exec "$value")\" " ;;
      NODE_BIN | TSX_LOADER | ENV_FILE | ENTRY | LOG_DIR) value="$(sd_exec "$value")" ;;
      STOP_TIMEOUT) ;;
      *) value="$(sd_env "$value")" ;;
    esac
    text="${text//@$key@/$value}"
  done
  printf '%s\n' "$text"
}

# render_definition <label> <url>: the definition of this platform.
render_definition() { if [[ "$MANAGER" == launchd ]]; then render_plist "$1" "$2"; else render_unit "$2"; fi; }

# ---- dry run: read-only, no lock --------------------------------------------------------------------------------
IDENT_DRY="$(ai_worker_identity "$MAIN_DIR" 2>/dev/null)" || IDENT_DRY=""
LABEL="$(ident_value "$IDENT_DRY" label)"
[[ -n "$LABEL" ]] || LABEL="$AI_WORKER_DEFAULT_LABEL"
if [[ "$DRY_RUN" -eq 1 ]]; then
  set_release_paths
  echo "release:   $RELEASE_DIR"
  echo "checkout:  $MAIN_DIR"
  echo "node:      $NODE_BIN"
  echo "claude:    ${CLAUDE_BIN:-NOT FOUND}"
  echo "codex:     ${CODEX_BIN:-NOT FOUND}"
  echo "database:  $(mask_url "$DB_URL")"
  echo "logs:      $LOG_DIR/ai-worker.{out,err}.log"
  echo "config:    $USER_CONFIG_DIR (over the defaults in $DEFAULTS_DIR)"
  echo "timeouts:  stop $STOP_TIMEOUT s, switch $SWAP_TIMEOUT s; releases kept: $RELEASES_KEEP"
  [[ -n "$IDENT_DRY" ]] || echo "warning: the ai-worker service identity is ambiguous: a real run refuses (not changed:)" >&2
  if [[ "$MANAGER" == launchd ]]; then
    echo "label:     $LABEL"
    echo "plist:     $HOME/Library/LaunchAgents/$LABEL.plist"
  else
    echo "unit:      $SYSTEMD_DIR/$SYSTEMD_UNIT"
  fi
  echo
  echo "--- definition (dry run: nothing is written or loaded; the password is masked) ---"
  render_definition "$LABEL" "$(mask_url "$DB_URL")"
  echo "--- would run ---"
  [[ -n "$HEAD_SHA" ]] && echo "$SCRIPT_DIR/prepare-release.sh $HEAD_SHA --root $MAIN_DIR"
  if [[ "$MANAGER" == launchd ]]; then
    echo "launchctl bootout $DOMAIN/<installed label>   # only when one is loaded; then wait until it is gone"
    echo "launchctl enable $DOMAIN/$LABEL"
    echo "launchctl bootstrap $DOMAIN $HOME/Library/LaunchAgents/$LABEL.plist"
  else
    echo "systemctl --user stop $SYSTEMD_UNIT   # only when installed; then wait until it is gone"
    echo "install -m 600 <unit> $SYSTEMD_DIR/$SYSTEMD_UNIT"
    echo "systemctl --user daemon-reload"
    echo "systemctl --user enable $SYSTEMD_UNIT"
    echo "systemctl --user start $SYSTEMD_UNIT"
  fi
  echo "wait for evidence of the new worker (pid, instance lock, heartbeat), else roll back"
  exit 0
fi

# ---- exit handler, lock ----------------------------------------------------------------------------------------
TMP_DEF=""       # the rendered definition before it is moved into place
TMP_PID=""       # the PID ai_worker_wait_ready prints
CLEANED=0
SWAP_ACTIVE=0    # 1 from the backup until the switch is decided
RESTORING=0
on_exit() {
  local rc=$? lrc=0
  set +e
  [[ "$CLEANED" == 0 ]] || return 0
  CLEANED=1
  if [[ "$SWAP_ACTIVE" == 1 && "$RESTORING" == 0 ]]; then
    # an unexpected error in the middle of the switch: restore what is there to restore
    echo "install-ai-worker: unexpected error during the switch (exit $rc); restoring the previous worker" >&2
    swap_restore "unexpected error (exit $rc)"
    rc=1
  fi
  [[ -z "$PROC_PGID" ]] || proc_group_wait "$PROC_PGID"
  rm -f "$TMP_DEF" "$TMP_PID"
  releases_lock_release "$MAIN_DIR" || lrc=$?
  if [[ "$lrc" == 3 ]]; then
    echo "install-ai-worker: descendant exit not confirmed; the release lock was left in place (see above)" >&2
    rc=1
  fi
  exit "$(proc_exit_rc "$rc")"
}
proc_traps on_exit

if ! releases_lock_acquire "$MAIN_DIR"; then
  if [[ "$RELEASES_LOCK_INIT_FAILED" == 0 && "$RELEASES_LOCK_VANISHED" == 0 && -z "${JOB_RADAR_RELEASES_LOCK_TOKEN:-}" ]]; then
    releases_lock_report "$MAIN_DIR" >&2
  fi
  not_changed "cannot take the release lock (see above)"
fi
releases_inflight_register "$MAIN_DIR" install-ai-worker || not_changed "cannot register in the release lock"

stopped_before_switch() { [[ "$STOPPING" == 1 ]] || return 0; echo "not changed: install-ai-worker: interrupted (SIG$STOP_SIGNAL) before the switch" >&2; exit 1; }

# ---- prepare the release of HEAD (without --release) -------------------------------------------------------------
if [[ -n "$HEAD_SHA" ]]; then
  echo "== release of HEAD ($HEAD_SHA): $SCRIPT_DIR/prepare-release.sh"
  prc=0; STEP_NAME="prepare-release" proc_run "$SCRIPT_DIR/prepare-release.sh" "$HEAD_SHA" --root "$MAIN_DIR" >&2 || prc=$?
  stopped_before_switch
  [[ "$prc" == 0 ]] || not_changed "prepare-release.sh failed (exit $prc); the installed worker is unchanged"
fi
[[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || not_changed "$RELEASE_DIR does not exist (prepare it: scripts/ops/prepare-release.sh $RELEASE_SHA --root $MAIN_DIR)"
release_path_ok "$MAIN_DIR" "$RELEASE_DIR" || not_changed "$RELEASE_DIR is not a release directory of $MAIN_DIR (or its parent is a symbolic link)"
release_marker_valid "$RELEASE_DIR" "$RELEASE_SHA" || not_changed "$RELEASE_DIR has no valid .release.json (sha, tree, lockfile); prepare it again"
set_release_paths
[[ -f "$TSX_LOADER_PATH" ]] || not_changed "$TSX_LOADER_PATH not found: the release is incomplete"
[[ -f "$ENTRY" ]] || not_changed "$ENTRY not found: the release is incomplete"
if [[ -f "$RELEASE_DIR/scripts/ops/check-node-engines.mjs" ]]; then
  NODE_OPTIONS="" "$NODE_BIN" "$RELEASE_DIR/scripts/ops/check-node-engines.mjs" "$RELEASE_DIR/package.json" >&2 \
    || not_changed "$NODE_BIN does not satisfy engines.node of $RELEASE_DIR/package.json"
fi

echo "release:   $RELEASE_DIR"
echo "checkout:  $MAIN_DIR"
echo "node:      $NODE_BIN"
echo "claude:    ${CLAUDE_BIN:-NOT FOUND}"
echo "codex:     ${CODEX_BIN:-NOT FOUND}"
echo "database:  $(mask_url "$DB_URL")"
echo "logs:      $LOG_DIR/ai-worker.{out,err}.log"

# ---- service manager helpers -------------------------------------------------------------------------------------
# override_of <label>: enabled / disabled / absent. launchd: the label's line of `launchctl print-disabled` (older
# macOS prints true for disabled); systemd: `systemctl --user is-enabled`, only enabled / disabled, absent when the unit
# file does not exist. Anything else (masked, an unreadable answer): 1.
override_of() {
  local out line state
  if [[ "$MANAGER" == launchd ]]; then
    out="$(launchctl print-disabled "$DOMAIN" 2>/dev/null)" || return 1
    line="$(printf '%s\n' "$out" | grep -F "\"$1\" =>" | head -n 1)" || line=""
    [[ -n "$line" ]] || { echo absent; return 0; }
    case "${line##*=> }" in
      disabled|true) echo disabled ;;
      enabled|false) echo enabled ;;
      *) return 1 ;;
    esac
  else
    [[ -e "$SYSTEMD_DIR/$SYSTEMD_UNIT" ]] || { echo absent; return 0; }
    state="$(systemctl --user is-enabled "$SYSTEMD_UNIT" 2>/dev/null)" || true
    case "$state" in enabled|disabled) echo "$state" ;; *) return 1 ;; esac
  fi
}
# set_override <label> <enabled|disabled|absent>: puts one enable override back (absent: nothing to do, see header (f)).
set_override() {
  local verb
  case "$2" in enabled) verb=enable ;; disabled) verb=disable ;; *) return 0 ;; esac
  if [[ "$MANAGER" == launchd ]]; then proc_run launchctl "$verb" "$DOMAIN/$1"
  else proc_run systemctl --user "$verb" "$SYSTEMD_UNIT"; fi
}
service_loaded() {   # service_loaded <label>: launchd has it / systemd: active, activating or reloading
  if [[ "$MANAGER" == launchd ]]; then launchctl print "$DOMAIN/$1" >/dev/null 2>&1
  else case "$(systemctl --user show -p ActiveState --value "$SYSTEMD_UNIT" 2>/dev/null)" in active|activating|reloading|deactivating) return 0 ;; *) return 1 ;; esac
  fi
}
service_pid() { ai_worker_service_pid "$MANAGER" "$1" "$SWAP_TIMEOUT"; }   # service_pid <label-or-unit>
target_of() { if [[ "$MANAGER" == launchd ]]; then echo "$1"; else echo "$SYSTEMD_UNIT"; fi; }   # what launchctl / systemctl get
# definition_db_url <file>: the DATABASE_URL a definition file sets (plutil, or the unit's exact escapes).
definition_db_url() {
  if [[ "$MANAGER" == launchd ]]; then
    local v; v="$(plutil -extract EnvironmentVariables.DATABASE_URL raw -o - "$1" 2>/dev/null)" || return 1
    printf '%s' "${v%$'\n'}"
  else sd_unit_db_url "$1"; fi
}
# stop_service <label>: bootout / stop, in its own process group.
stop_service() {
  if [[ "$MANAGER" == launchd ]]; then proc_run launchctl bootout "$DOMAIN/$1"
  else proc_run systemctl --user stop "$SYSTEMD_UNIT"; fi
}
# start_service <label> <definition>: enable first, then bootstrap / start.
start_service() {
  if [[ "$MANAGER" == launchd ]]; then
    proc_run launchctl enable "$DOMAIN/$1" && proc_run launchctl bootstrap "$DOMAIN" "$2"
  else
    proc_run systemctl --user daemon-reload && proc_run systemctl --user enable "$SYSTEMD_UNIT" && proc_run systemctl --user start "$SYSTEMD_UNIT"
  fi
}
# wait_ready_as <url> <old pid> <since>: ai_worker_wait_ready with that DATABASE_URL; the PID lands in READY_PID.
READY_PID=""
wait_ready_as() {
  local rc=0
  READY_PID=""
  : > "$TMP_PID"
  DATABASE_URL="$1" ai_worker_wait_ready "$MAIN_DIR" "$2" "$3" "$SWAP_TIMEOUT" > "$TMP_PID" || rc=$?
  READY_PID="$(head -n 1 "$TMP_PID" 2>/dev/null)" || READY_PID=""
  return "$rc"
}

# ---- (f) step 1: preconditions -----------------------------------------------------------------------------------
IDENT="$(ai_worker_identity "$MAIN_DIR")" || not_changed "the ai-worker service identity is ambiguous (see above); remove all definitions but one (scripts/ops/uninstall-ai-worker.sh), then retry"
LABEL="$(ident_value "$IDENT" label)"
FOUND_LABEL="$(ident_value "$IDENT" found_label)"
FOUND_DEF="$(ident_value "$IDENT" found_definition)"
ORIGIN="$(ident_value "$IDENT" origin)"
if [[ "$MANAGER" == launchd ]]; then NEW_DEF="$HOME/Library/LaunchAgents/$LABEL.plist"; else NEW_DEF="$SYSTEMD_DIR/$SYSTEMD_UNIT"; LABEL="$SYSTEMD_UNIT"; fi
[[ ! -e "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] \
  || not_changed "an unresolved switch backup exists: $BACKUP_DIR (a previous switch failed; see docs/upgrade.md, then remove it)"
T0="$(DATABASE_URL="$DB_URL" ai_worker_db_now "$SWAP_TIMEOUT")" \
  || not_changed "cannot read the database clock at $(mask_url "$DB_URL") (is the database up? docker compose up -d)"
OVERRIDE_TARGET="$(override_of "$LABEL")" || not_changed "cannot record the enable state of $LABEL (systemd: is-enabled must say enabled or disabled; masked is refused)"
OVERRIDE_FOUND="absent"
if [[ -n "$FOUND_LABEL" ]]; then
  OVERRIDE_FOUND="$(override_of "$FOUND_LABEL")" || not_changed "cannot record the enable state of $FOUND_LABEL"
fi
WAS_LOADED=0; WAS_RUNNING=0; P0=""
if [[ -n "$FOUND_LABEL" ]]; then
  service_loaded "$FOUND_LABEL" && WAS_LOADED=1
  P0="$(service_pid "$(target_of "$FOUND_LABEL")")"
  [[ -z "$P0" ]] || WAS_RUNNING=1
fi
ORIG_DB_URL=""
if [[ -n "$FOUND_DEF" && "$WAS_RUNNING" == 1 ]]; then
  ORIG_DB_URL="$(definition_db_url "$FOUND_DEF")" && [[ -n "$ORIG_DB_URL" ]] \
    || not_changed "cannot read the database URL of the installed definition (unsupported Environment= syntax): $FOUND_DEF"
fi
PREV_RELEASE=""
prc=0; PREV_RELEASE="$(print_release 2>/dev/null)" || prc=$?
PRINT_RELEASE_RC="$prc"
[[ "$prc" == 0 ]] || PREV_RELEASE=""
stopped_before_switch

# ---- step 2: backup ----------------------------------------------------------------------------------------------
mkdir -p "$MAIN_DIR/data/run" || not_changed "cannot create $MAIN_DIR/data/run"
mkdir -m 700 "$BACKUP_DIR" 2>/dev/null || not_changed "cannot create the backup $BACKUP_DIR (or it appeared meanwhile)"
SWAP_ACTIVE=1
SWAP_PHASE=2   # 2 backup, 4 stopping the old worker, 5 the new definition written, 6 waiting for evidence
BACKUP_FILE=""
if [[ -n "$FOUND_DEF" ]]; then
  BACKUP_FILE="$BACKUP_DIR/$(basename "$FOUND_DEF")"
  cp -p "$FOUND_DEF" "$BACKUP_FILE" && chmod 600 "$BACKUP_FILE" || { SWAP_ACTIVE=0; rm -rf -- "$BACKUP_DIR"; not_changed "cannot copy $FOUND_DEF into the backup"; }
fi
{
  printf 'found_label=%s\ntarget_label=%s\noverride_found=%s\noverride_target=%s\n' "$FOUND_LABEL" "$LABEL" "$OVERRIDE_FOUND" "$OVERRIDE_TARGET"
  printf 'was_loaded=%s\nwas_running=%s\np0=%s\nprint_release=%s\nprint_release_rc=%s\nt0=%s\n' "$WAS_LOADED" "$WAS_RUNNING" "$P0" "$PREV_RELEASE" "$PRINT_RELEASE_RC" "$T0"
  printf 'found_definition=%s\nnew_definition=%s\nrelease=%s\n' "$FOUND_DEF" "$NEW_DEF" "$RELEASE_DIR"
} > "$BACKUP_DIR/state" || { SWAP_ACTIVE=0; rm -rf -- "$BACKUP_DIR"; not_changed "cannot write $BACKUP_DIR/state"; }
chmod 600 "$BACKUP_DIR/state"

# remove_backup: only the directory this run created (its fixed path under the main checkout).
remove_backup() { [[ -n "$MAIN_DIR" && "$BACKUP_DIR" == "$MAIN_DIR/data/run/ai-worker-swap-backup" ]] && rm -rf -- "$BACKUP_DIR"; }

# ---- step 7: restore ---------------------------------------------------------------------------------------------
P1=""
rollback_failed() {
  echo "ROLLBACK FAILED: install-ai-worker: $1" >&2
  echo "  state: $2" >&2
  echo "  backup (the original definition and state; kept): $BACKUP_DIR" >&2
  echo "  to fix by hand: stop every ai-worker ($( [[ "$MANAGER" == launchd ]] && echo "launchctl bootout $DOMAIN/<label>" || echo "systemctl --user stop $SYSTEMD_UNIT" ); check with: pgrep -fl src/ai-worker/index.ts)," >&2
  echo "  put $BACKUP_DIR/$(basename "${FOUND_DEF:-<none>}") back to ${FOUND_DEF:-<nothing was installed>}, start it, then remove $BACKUP_DIR (docs/upgrade.md)" >&2
  SWAP_ACTIVE=0
  return 1
}
# swap_restore <reason>: step 7 of the switch. Ignores signals from here on (RESTORING=1); every state-changing command
# runs in its own process group. Exits nothing: returns 0 = rolled back, 1 = ROLLBACK FAILED (both print the line).
swap_restore() {
  local reason="$1" target t1 url_backup
  RESTORING=1
  AI_WORKER_STOP_CHECK=0
  if (( SWAP_PHASE < 4 )); then
    remove_backup; SWAP_ACTIVE=0
    echo "not changed: install-ai-worker: $reason; nothing was switched" >&2
    return 0
  fi
  # 1. stop the candidate under L and wait until it is gone
  if (( SWAP_PHASE >= 5 )); then
    target="$(target_of "$LABEL")"
    [[ -n "$P1" ]] || P1="$(service_pid "$target")"
    stop_service "$LABEL" || true
    if ! ai_worker_wait_stopped "$target" "$P1" "$SWAP_TIMEOUT"; then
      rollback_failed "the new worker ${P1:+(pid $P1) }did not stop within $SWAP_TIMEOUT s; the previous worker was not started (two workers must never run)" \
        "new definition $NEW_DEF loaded; previous definition only in the backup"
      return 1
    fi
    # 2. remove the new definition (systemd: undo this run's enable first, then daemon-reload)
    if [[ "$MANAGER" == systemd ]]; then
      if ! proc_run systemctl --user disable "$SYSTEMD_UNIT"; then
        rollback_failed "systemctl --user disable $SYSTEMD_UNIT failed" "new unit $NEW_DEF stopped, still installed"
        return 1
      fi
      rm -f "$NEW_DEF"
      proc_run systemctl --user daemon-reload || true
    else
      rm -f "$NEW_DEF"
    fi
  fi
  # 3. the original process survived the stop
  if [[ -n "$P0" ]] && ai_worker_pid_alive "$P0"; then
    [[ -z "$FOUND_DEF" ]] || cp -p "$BACKUP_FILE" "$FOUND_DEF" || true
    [[ "$MANAGER" == launchd ]] || proc_run systemctl --user daemon-reload || true
    restore_overrides || true
    rollback_failed "original process $P0 survived the stop and is no longer managed (stop it: kill $P0)" \
      "previous definition put back, not loaded; pid $P0 still running"
    return 1
  fi
  if [[ -z "$FOUND_DEF" ]]; then
    # 4. nothing was installed before
    restore_overrides || true
    if service_loaded "$LABEL" || [[ -e "$NEW_DEF" ]] || { [[ "$MANAGER" == systemd ]] && wants_links_exist; }; then
      rollback_failed "the new definition could not be removed completely" "check $NEW_DEF and the service manager"
      return 1
    fi
    remove_backup; SWAP_ACTIVE=0
    echo "rolled back: install-ai-worker: $reason; no ai-worker was installed before, none is now" >&2
    return 0
  fi
  # 5. put the previous definition back under its own label
  if ! cp -p "$BACKUP_FILE" "$FOUND_DEF"; then
    rollback_failed "cannot copy the backup back to $FOUND_DEF" "no definition installed"
    return 1
  fi
  [[ "$MANAGER" == launchd ]] || proc_run systemctl --user daemon-reload || true
  if [[ "$WAS_RUNNING" == 1 ]]; then
    url_backup="$(definition_db_url "$BACKUP_FILE")" || url_backup=""
    if [[ -z "$url_backup" || "$url_backup" != "$ORIG_DB_URL" ]]; then
      rollback_failed "the database URL in the backup differs from the one read before the switch (was the backup changed?)" \
        "previous definition put back, not started"
      return 1
    fi
    if ! start_service "$FOUND_LABEL" "$FOUND_DEF"; then
      rollback_failed "starting the previous definition ($FOUND_LABEL) failed" "previous definition put back, not running"
      return 1
    fi
    if ! t1="$(DATABASE_URL="$ORIG_DB_URL" ai_worker_db_now "$SWAP_TIMEOUT")" || ! wait_ready_as "$ORIG_DB_URL" "${P1:-$P0}" "$t1"; then
      rollback_failed "the previous worker did not show evidence (instance lock and heartbeat) within $SWAP_TIMEOUT s" \
        "previous definition put back and started, not proven ready"
      return 1
    fi
  elif [[ "$WAS_LOADED" == 1 && "$MANAGER" == launchd ]]; then
    # loaded but without a process (e.g. throttled): loaded again, no evidence to wait for
    if ! start_service "$FOUND_LABEL" "$FOUND_DEF"; then
      rollback_failed "loading the previous definition ($FOUND_LABEL) failed" "previous definition put back, not loaded"
      return 1
    fi
  elif service_loaded "$FOUND_LABEL"; then
    rollback_failed "the previous worker was stopped before the switch, but is loaded now" "previous definition put back"
    return 1
  fi
  # 6. both enable overrides as they were ("disabled but running": disabled again only now, after the evidence)
  if ! restore_overrides; then
    rollback_failed "cannot restore the enable state of $LABEL / $FOUND_LABEL" "previous worker back${READY_PID:+, pid $READY_PID}"
    return 1
  fi
  remove_backup; SWAP_ACTIVE=0
  echo "rolled back: install-ai-worker: $reason; the previous worker is back (${READY_PID:+pid $READY_PID, }label $FOUND_LABEL)" >&2
  return 0
}
# restore_overrides: L, and the found label when it differs, to their values in the backup. systemd has one unit; its
# value is only set when the unit file exists again (absent: this run's links were removed in step 2).
restore_overrides() {
  local rc=0
  if [[ "$MANAGER" == launchd ]]; then
    set_override "$LABEL" "$OVERRIDE_TARGET" || rc=1
    if [[ -n "$FOUND_LABEL" && "$FOUND_LABEL" != "$LABEL" ]]; then set_override "$FOUND_LABEL" "$OVERRIDE_FOUND" || rc=1; fi
  elif [[ -e "$SYSTEMD_DIR/$SYSTEMD_UNIT" ]]; then
    set_override "$SYSTEMD_UNIT" "$OVERRIDE_FOUND" || rc=1
  fi
  return "$rc"
}
wants_links_exist() {   # a link to the unit in any *.wants/ directory of the user unit directory (dangling ones too)
  local f
  for f in "$SYSTEMD_DIR"/*.wants/"$SYSTEMD_UNIT"; do [[ -e "$f" || -L "$f" ]] && return 0; done
  return 1
}
# fail_switch <reason>: step 7, then exit 1 (the signal's code when one arrived; on_exit decides).
fail_switch() {
  local rrc=0
  swap_restore "$1" || rrc=$?
  exit 1
}
# check_stopping <step>: a signal before the new worker is ready means: roll back.
check_stopping() { [[ "$STOPPING" == 1 ]] && fail_switch "interrupted (SIG$STOP_SIGNAL) at step $1"; return 0; }

# ---- step 3: the new definition ----------------------------------------------------------------------------------
check_stopping 3
TMP_DEF="$(mktemp "${TMPDIR:-/tmp}/ai-worker-definition.XXXXXX")" || fail_switch "cannot create a temporary file"
TMP_PID="$(mktemp "${TMPDIR:-/tmp}/ai-worker-pid.XXXXXX")" || fail_switch "cannot create a temporary file"
chmod 600 "$TMP_DEF"
render_definition "$LABEL" "$DB_URL" > "$TMP_DEF" || fail_switch "cannot render the definition"
if [[ "$MANAGER" == launchd ]]; then plutil -lint "$TMP_DEF" >/dev/null || fail_switch "the generated plist is not valid"; fi

# ---- step 4: stop the old worker ---------------------------------------------------------------------------------
check_stopping 4
SWAP_PHASE=4
AI_WORKER_STOP_CHECK=1
if [[ -n "$FOUND_LABEL" ]]; then
  if [[ "$MANAGER" == systemd || "$WAS_LOADED" == 1 ]]; then
    echo "== stopping the installed worker ($FOUND_LABEL${P0:+, pid $P0})"
    stop_service "$FOUND_LABEL" || true
  fi
  ai_worker_wait_stopped "$(target_of "$FOUND_LABEL")" "$P0" "$SWAP_TIMEOUT" \
    || fail_switch "the installed worker${P0:+ (pid $P0)} did not stop within $SWAP_TIMEOUT s"
fi

# ---- step 5: install under L -------------------------------------------------------------------------------------
check_stopping 5
SWAP_PHASE=5
mkdir -p "$LOG_DIR" "$(dirname "$NEW_DEF")" || fail_switch "cannot create $LOG_DIR or $(dirname "$NEW_DEF")"
[[ "$MANAGER" != launchd ]] || mkdir -p "$LAUNCHD_LOG_DIR" || fail_switch "cannot create $LAUNCHD_LOG_DIR"
mv "$TMP_DEF" "$NEW_DEF" || fail_switch "cannot write $NEW_DEF"
chmod 600 "$NEW_DEF"
# a definition under the default or the old label goes now (its copy is in the backup): one definition at most
if [[ -n "$FOUND_DEF" && "$FOUND_DEF" != "$NEW_DEF" ]]; then rm -f "$FOUND_DEF"; fi
echo "== starting the worker from $RELEASE_DIR ($LABEL)"
start_service "$LABEL" "$NEW_DEF" || fail_switch "starting $LABEL failed (launchctl bootstrap / systemctl --user start)"

# ---- step 6: evidence --------------------------------------------------------------------------------------------
check_stopping 6
SWAP_PHASE=6
if ! wait_ready_as "$DB_URL" "$P0" "$T0"; then
  P1="$(service_pid "$(target_of "$LABEL")")"
  if [[ "$STOPPING" == 1 ]]; then fail_switch "interrupted (SIG$STOP_SIGNAL) while waiting for the new worker"; fi
  fail_switch "the new worker did not show evidence (a new pid holding the instance lock, a heartbeat since $T0) within $SWAP_TIMEOUT s; logs: $LOG_DIR/ai-worker.err.log"
fi
P1="$READY_PID"
AI_WORKER_STOP_CHECK=0
SWAP_ACTIVE=0

# ---- step 8: clean up, then drop the backup ----------------------------------------------------------------------
# cleanup_releases: keeps the new release, the previous one and the newest others (by .release.json created) up to
# deploy.ai_worker_releases_keep in total; removes the rest with release_rm (path checked, never a link). Then the
# .tmp-* / .trash-* left by failed runs. Under the lock; failures only warn.
cleanup_releases() {
  local f name created kept=1 n=0 list
  [[ -n "$PREV_RELEASE" && "$PREV_RELEASE" != "$RELEASE_DIR" && -d "$PREV_RELEASE" ]] && kept=2
  list="$(for f in "$RELEASES_PARENT"/*; do
            name="${f##*/}"
            [[ "$name" =~ ^[0-9a-f]{40}$ && -d "$f" && ! -L "$f" ]] || continue
            [[ "$f" != "$RELEASE_DIR" && "$f" != "$PREV_RELEASE" ]] || continue
            created="$(release_marker_field "$f/.release.json" created)"
            printf '%s %s\n' "${created:-0}" "$f"
          done | sort -r)"
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    f="${f#* }"
    n=$((n + 1))
    (( n + kept > RELEASES_KEEP )) || continue
    echo "removing the old release $f"
    release_rm "$MAIN_DIR" "$f" || echo "warning: could not remove $f" >&2
  done <<< "$list"
  sweep_tmp "$MAIN_DIR" || echo "warning: could not remove every leftover .tmp-* / .trash-* in $RELEASES_PARENT" >&2
}
if [[ "$STOPPING" == 1 ]]; then
  echo "install-ai-worker: interrupted (SIG$STOP_SIGNAL) after the new worker was ready: old releases not cleaned up" >&2
else
  cleanup_releases
fi
remove_backup || echo "warning: could not remove the backup $BACKUP_DIR" >&2
# Logs that installs from before data/logs/ left in launchd's capture directory move next to the new logs, once (a moved
# file is gone, so a second run has nothing to do). Only after a successful switch; failures only warn.
if [[ "$MANAGER" == launchd ]]; then
  for name in ai-worker.out.log ai-worker.err.log; do
    old="$LAUNCHD_LOG_DIR/$name"
    [[ -f "$old" && ! -L "$old" ]] || continue
    target="$LOG_DIR/${name%.log}.before-upgrade.log"
    if cat "$old" >> "$target" && rm -f -- "$old"; then echo "moved $old -> $target"
    else echo "warning: could not move $old to $target; it stays where it is" >&2; fi
  done
fi
if [[ "$MANAGER" == systemd && "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  echo "note: the worker stops when you log out. To keep it running: loginctl enable-linger $(id -un)"
fi
echo "installed: $LABEL runs $RELEASE_SHA from $RELEASE_DIR (pid $P1)"
proc_check_stop
exit 0
