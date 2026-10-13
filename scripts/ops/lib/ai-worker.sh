#!/usr/bin/env bash
# The host ai-worker's identity and service state, shared by the ops scripts (sourced, not run on its own).
#
#   ai_worker_stop    stops the agent / unit when it is running and remembers that, so that
#   ai_worker_start   starts it again only if ai_worker_stop stopped it (both used by scripts/ops/restore.sh)
#   ai_worker_label   the resolved launchd label L (see ai_worker_identity), the default one when L is not valid
#   ai_worker_identity <main>       which service definition is the worker's (key=value lines; files only)
#   ai_worker_wait_ready <main> <old pid> <since> <timeout>   until a new PID of the installed definition shows evidence
#   ai_worker_wait_stopped <label-or-unit> <pid> <timeout>     until the service and the PID are gone
#   ai_worker_db_url <main> [--database-url X]                 the DATABASE_URL the install script writes
#   sd_env_decode / sd_path_decode / sd_unit_db_url            exact inverses of the install script's unit escaping
#
# The platform is JOB_RADAR_SERVICE_MANAGER (launchd or systemd) when set, else launchd on macOS and systemd elsewhere.
#
# macOS: the launchd agent whose label is `doctor.ai_worker_launchd_label` of schedule.yaml (default io.jobradar.ai-worker):
#        `launchctl bootout` / `launchctl bootstrap` with ~/Library/LaunchAgents/<label>.plist.
# Linux: the systemd user unit job-radar-ai-worker.service (`systemctl --user stop` / `start`).
# Nothing found (no agent, no unit, no systemctl): a loud notice and the restore goes on. That is safe: the restore terminates
# every connection to the old database before it swaps, so a worker that is still running reconnects to the restored
# database and never writes into the old one.
#
# ai_worker_stop / ai_worker_start / ai_worker_label need $app (the checkout) from the caller; failing to stop or start never
# fails the restore. The other functions take everything as arguments.

AI_WORKER_SYSTEMD_UNIT="job-radar-ai-worker.service"
AI_WORKER_DEFAULT_LABEL="io.jobradar.ai-worker"
AI_WORKER_LEGACY_LABEL="de.jobradar.ai-worker"
# The checkout this file belongs to: worker-heartbeat.ts runs from here (never from the checkout being installed).
AI_WORKER_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
# What ai_worker_stop did: "", "launchd" or "systemd".
AI_WORKER_STOPPED_BY=""
AI_WORKER_LABEL_USED=""

# ai_worker_label: L from ai_worker_identity "$app" (launchd rules; still known when more than one definition exists);
# the default label when L cannot be read or is not valid, as before.
ai_worker_label() {
  local label=""
  label="$(JOB_RADAR_SERVICE_MANAGER=launchd ai_worker_identity "$app" 2>/dev/null | sed -n 's/^label=//p' | head -n 1)" || true
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || label="$AI_WORKER_DEFAULT_LABEL"
  printf '%s' "$label"
}

# ai_worker_yaml_scalar <rest of a `key:` line>: the value of a one-line YAML scalar, plain or in matching quotes, with a
# trailing ` #` comment dropped; an empty value prints nothing. Returns 1 for an unclosed quote or text after the closing
# quote. No escapes are interpreted (a label has none).
ai_worker_yaml_scalar() {
  local v="${1%$'\r'}" q
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
    \"*|\'*)
      q="${v:0:1}"; v="${v:1}"
      [[ "$v" == *"$q"* ]] || return 1
      local rest="${v#*"$q"}"
      v="${v%%"$q"*}"
      # after the closing quote: nothing, or whitespace and then nothing or a comment
      [[ -z "$rest" || "$rest" =~ ^[[:space:]]+(#.*)?$ ]] || return 1 ;;
    "#"*) v="" ;;
    *)
      v="${v%%[[:space:]]#*}"   # a comment starts at the first whitespace followed by #
      v="${v%"${v##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$v"
}

ai_worker_platform() {   # launchd or systemd
  case "${JOB_RADAR_SERVICE_MANAGER:-}" in
    launchd|systemd) echo "$JOB_RADAR_SERVICE_MANAGER" ;;
    *) if [[ "$(uname -s)" == "Darwin" ]]; then echo launchd; else echo systemd; fi ;;
  esac
}

# ai_worker_identity <main>: which service definition is the worker's. Reads files only (no node, launchctl or systemctl,
# nothing from $app). Prints key=value lines:
#   platform          launchd or systemd
#   label             L: doctor.ai_worker_launchd_label of <main>/data/config/schedule.yaml when that file exists, else of
#                     <main>/config/schedule.yaml; io.jobradar.ai-worker when the key is missing or empty. The whole
#                     scalar is the value (plain, or in matching single or double quotes; a ` #` comment after it is
#                     dropped), so `com.example.worker invalid` is not a valid label
#   definition        where L's definition lives (~/Library/LaunchAgents/<L>.plist, or the systemd user unit file
#                     ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/job-radar-ai-worker.service)
#   found_label       the label (systemd: the unit) whose definition exists, empty when none
#   found_definition  its file, empty when none
#   origin            resolved (under L), default (under io.jobradar.ai-worker while L differs), legacy (under
#                     de.jobradar.ai-worker) or none
# Exit 0 when exactly one candidate (L; the default label when L differs; the legacy label) has a definition, or none
# has. Exit 1 when the identity is ambiguous: more than one definition (stdout then stops after `definition`, the files
# go to stderr), or the label cannot be read or is not ^[A-Za-z0-9._-]+$ (stdout stops after `platform`).
ai_worker_identity() {
  local main="$1" platform schedule label="" home cand file found_label="" found_def="" origin=none n=0 seen=" " dir
  platform="$(ai_worker_platform)"
  echo "platform=$platform"
  schedule="$main/data/config/schedule.yaml"
  [[ -f "$schedule" ]] || schedule="$main/config/schedule.yaml"
  if [[ -e "$schedule" ]]; then
    if [[ ! -r "$schedule" ]]; then echo "ai-worker: cannot read $schedule" >&2; return 1; fi
    label="$(awk '/^doctor:/ { in_doctor = 1; next } /^[^ #]/ { in_doctor = 0 } in_doctor && $1 == "ai_worker_launchd_label:" { sub(/^[ \t]*ai_worker_launchd_label:/, ""); print; exit }' "$schedule")" \
      || { echo "ai-worker: cannot read $schedule" >&2; return 1; }
    label="$(ai_worker_yaml_scalar "$label")" \
      || { echo "ai-worker: doctor.ai_worker_launchd_label in $schedule is not a plain or quoted scalar" >&2; return 1; }
  fi
  label="${label:-$AI_WORKER_DEFAULT_LABEL}"
  if [[ ! "$label" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "ai-worker: doctor.ai_worker_launchd_label in $schedule is not a valid label (letters, digits, . _ - only)" >&2
    return 1
  fi
  echo "label=$label"
  if [[ "$platform" == systemd ]]; then
    if [[ -z "${XDG_CONFIG_HOME:-}" && -z "${HOME:-}" ]]; then echo "ai-worker: neither XDG_CONFIG_HOME nor HOME is set" >&2; return 1; fi
    dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    file="$dir/$AI_WORKER_SYSTEMD_UNIT"
    echo "definition=$file"
    if [[ -e "$file" || -L "$file" ]]; then found_label="$AI_WORKER_SYSTEMD_UNIT"; found_def="$file"; origin=resolved; fi
  else
    if [[ -z "${HOME:-}" ]]; then echo "ai-worker: HOME is not set" >&2; return 1; fi
    dir="$HOME/Library/LaunchAgents"
    echo "definition=$dir/$label.plist"
    for cand in "$label:resolved" "$AI_WORKER_DEFAULT_LABEL:default" "$AI_WORKER_LEGACY_LABEL:legacy"; do
      case "$seen" in *" ${cand%%:*} "*) continue ;; esac
      seen="$seen${cand%%:*} "
      file="$dir/${cand%%:*}.plist"
      [[ -e "$file" || -L "$file" ]] || continue
      n=$((n + 1))
      if (( n > 1 )); then
        echo "ai-worker: more than one ai-worker definition: $found_def and $file; remove all but one (scripts/ops/uninstall-ai-worker.sh), then retry" >&2
        return 1
      fi
      found_label="${cand%%:*}"; found_def="$file"; origin="${cand##*:}"
    done
  fi
  echo "found_label=$found_label"
  echo "found_definition=$found_def"
  echo "origin=$origin"
  return 0
}

# ai_worker_service_pid <platform> <label-or-unit> [timeout s]: the PID the service manager reports, or nothing. With a
# timeout, the launchctl / systemctl call is given at most that long (ai_worker_run_bounded) and reports nothing when cut
# off; its output goes to a temp file, not a pipe, so that nothing left behind can hold the call open.
ai_worker_service_pid() {
  local platform="$1" target="$2" secs="${3:-}" out="" f
  f="$(mktemp "${TMPDIR:-/tmp}/ai-worker-pid.XXXXXX")" || return 0
  case "$platform" in
    launchd) set -- launchctl print "gui/$(id -u)/$target" ;;
    systemd) set -- systemctl --user show -p MainPID --value "$target" ;;
    *) rm -f "$f"; return 0 ;;
  esac
  if [[ -n "$secs" ]]; then
    ai_worker_run_bounded "$secs" ai_worker_exec_to "$f" "$@" || true
  else
    "$@" > "$f" 2>/dev/null || true
  fi
  case "$platform" in
    launchd) out="$(awk '$1 == "pid" && $2 == "=" { print $3; exit }' "$f" 2>/dev/null)" || out="" ;;
    systemd) out="$(cat "$f" 2>/dev/null)" || out="" ;;
  esac
  rm -f "$f"
  out="${out//[[:space:]]/}"
  [[ "$out" =~ ^[0-9]+$ && "$out" != 0 ]] && printf '%s\n' "$out"
  return 0
}

# ai_worker_run_bounded <seconds> <command…>: runs the command in the background and waits at most <seconds> for it;
# returns its exit status, or 124 after killing it (TERM, then KILL a second later) when the time is up. The command
# should exec its program, so that the PID killed is the program's.
ai_worker_run_bounded() {
  local secs="$1" p rc=0 end i
  shift
  "$@" &
  p=$!
  end=$((SECONDS + secs))
  while kill -0 "$p" 2>/dev/null; do
    if (( SECONDS >= end )); then
      kill -TERM "$p" 2>/dev/null
      for i in 1 2 3 4 5; do kill -0 "$p" 2>/dev/null || break; sleep 0.2; done
      if kill -0 "$p" 2>/dev/null; then kill -KILL "$p" 2>/dev/null; fi
      wait "$p" 2>/dev/null
      return 124
    fi
    sleep 0.2
  done
  wait "$p" || rc=$?
  return "$rc"
}

# ai_worker_exec_to <file> <command…>: execs the command with stdout to <file> and stderr discarded.
ai_worker_exec_to() { local f="$1"; shift; exec "$@" > "$f" 2>/dev/null; }

# ai_worker_evidence_probe <pid> <host> <since>: worker-heartbeat.ts --evidence, run from this checkout (its tsconfig and
# tsx), with the caller's DATABASE_URL; exec, so that ai_worker_run_bounded can kill it.
ai_worker_evidence_probe() {
  cd "$AI_WORKER_REPO" || exit 1
  DATABASE_URL="$DATABASE_URL" exec node --import "$AI_WORKER_REPO/node_modules/tsx/dist/loader.mjs" \
    scripts/ops/worker-heartbeat.ts --evidence --pid "$1" --host "$2" --since "$3" >/dev/null 2>&1 </dev/null
}

# ai_worker_wait_ready <main> <old pid> <since> <timeout s>: waits until the service manager reports a PID P other than
# <old pid> and the database shows evidence for it: worker-heartbeat.ts --evidence --pid P --host <this host> --since
# <since> exits 0 (P holds the worker's instance lock and wrote a heartbeat after <since>). Exit 2 (not yet) or 1 (cannot
# tell, e.g. the lock holder is another database role) both mean "not ready": it keeps waiting. Once there is evidence it
# checks the PID once more, prints P and returns 0.
# The service polled is the definition in force when it is called: found_label of ai_worker_identity <main> (systemd: the
# unit), not the configured label L. After a failed migration from the default or legacy label to L, the rollback puts
# the definition back under its old label, and this waits for that one.
# Every call (the service manager's PID, the evidence probe, the PID confirmation) is bounded by the time left, which is
# recomputed after each one, and success counts only within the timeout. Returns 1 on timeout, when no
# definition exists, when the identity is ambiguous, or at once when DATABASE_URL is empty: the caller sets it
# explicitly (the URL written into the definition), it is never read from .env or derived here.
ai_worker_wait_ready() {
  local main="$1" old="$2" since="$3" timeout="$4" platform target ident host pid deadline left
  [[ -n "${DATABASE_URL:-}" ]] || { echo "ai-worker: ai_worker_wait_ready needs DATABASE_URL set by the caller" >&2; return 1; }
  [[ "$timeout" =~ ^[0-9]+$ ]] || { echo "ai-worker: timeout must be whole seconds, got '$timeout'" >&2; return 1; }
  ident="$(ai_worker_identity "$main")" || return 1
  platform="$(printf '%s\n' "$ident" | sed -n 's/^platform=//p')"
  target="$(printf '%s\n' "$ident" | sed -n 's/^found_label=//p')"
  [[ -n "$target" ]] || { echo "ai-worker: no ai-worker definition is installed; nothing to wait for" >&2; return 1; }
  host="$(hostname)"
  # SECONDS counts whole seconds: one more makes the wait at least <timeout> s long (and less than <timeout> + 1)
  deadline=$((SECONDS + timeout + 1))
  while :; do
    left=$((deadline - SECONDS)); (( left > 0 )) || return 1
    pid="$(ai_worker_service_pid "$platform" "$target" "$left")"
    left=$((deadline - SECONDS)); (( left > 0 )) || return 1
    if [[ -n "$pid" && "$pid" != "$old" ]] && ai_worker_run_bounded "$left" ai_worker_evidence_probe "$pid" "$host" "$since"; then
      left=$((deadline - SECONDS)); (( left > 0 )) || return 1
      if [[ "$(ai_worker_service_pid "$platform" "$target" "$left")" == "$pid" ]] && (( SECONDS <= deadline )); then
        printf '%s\n' "$pid"
        return 0
      fi
    fi
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

# ai_worker_wait_stopped <label-or-unit> <pid> <timeout s>: 0 once the worker is stopped, 1 on timeout. Checked every second:
#   launchd  `launchctl print gui/<uid>/<label>` fails and <pid> is gone;
#   systemd  ActiveState is inactive or failed, MainPID=0, `systemctl --user list-jobs` has no job for the unit, NRestarts
#            equals the previous reading, and <pid> is gone (LoadState is not looked at).
ai_worker_wait_stopped() {
  local target="$1" pid="$2" timeout="$3" platform deadline state active mainpid restarts prev="" jobs
  [[ "$timeout" =~ ^[0-9]+$ ]] || { echo "ai-worker: timeout must be whole seconds, got '$timeout'" >&2; return 1; }
  platform="$(ai_worker_platform)"
  deadline=$((SECONDS + timeout))
  while :; do
    if [[ "$platform" == launchd ]]; then
      if ! launchctl print "gui/$(id -u)/$target" >/dev/null 2>&1 && ! ai_worker_pid_alive "$pid"; then return 0; fi
    else
      state="$(systemctl --user show -p ActiveState,SubState,MainPID,NRestarts "$target" 2>/dev/null)" || state=""
      active="$(printf '%s\n' "$state" | sed -n 's/^ActiveState=//p')"
      mainpid="$(printf '%s\n' "$state" | sed -n 's/^MainPID=//p')"
      restarts="$(printf '%s\n' "$state" | sed -n 's/^NRestarts=//p')"
      jobs="$(systemctl --user list-jobs --no-legend "$target" 2>/dev/null)" || jobs="?"
      if [[ ( "$active" == inactive || "$active" == failed ) && "$mainpid" == 0 && -z "${jobs//[[:space:]]/}" \
            && -n "$restarts" && "$restarts" == "$prev" ]] && ! ai_worker_pid_alive "$pid"; then
        return 0
      fi
      prev="$restarts"
    fi
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

ai_worker_pid_alive() { [[ "$1" =~ ^[0-9]+$ && "$1" != 0 ]] && kill -0 "$1" 2>/dev/null; }   # never `kill -0 0` (own group)

# ai_worker_db_url <main> [--database-url X]: the DATABASE_URL the install script uses, taken over as it is (same order,
# same defaults): the argument; else $DATABASE_URL; else DATABASE_URL in <main>/.env; else postgres://<POSTGRES_USER>:
# <POSTGRES_PASSWORD>@127.0.0.1:<DB_HOST_PORT>/<POSTGRES_DB> from <main>/.env, each missing part jobradar / jobradar /
# 5433 / jobradar. .env is read with grep (never sourced). Always prints a URL on stdout and returns 0; the caller checks
# the format and never prints it unmasked.
ai_worker_env_value() { # ai_worker_env_value <main> KEY -> value from <main>/.env (first match, quotes stripped), or empty
  local file="$1/.env"
  [[ -f "$file" ]] || return 0
  grep -E "^[[:space:]]*$2=" "$file" | head -n1 | sed -E "s/^[[:space:]]*$2=//; s/^['\"]//; s/['\"][[:space:]]*\$//" || true
}
ai_worker_db_url() {
  local main="$1" arg="" DB_URL db_user db_pass db_name db_port
  shift
  if [[ "${1:-}" == --database-url ]]; then arg="${2:-}"; fi
  DB_URL="$arg"
  [[ -n "$DB_URL" ]] || DB_URL="${DATABASE_URL:-}"
  [[ -n "$DB_URL" ]] || DB_URL="$(ai_worker_env_value "$main" DATABASE_URL)"
  if [[ -z "$DB_URL" ]]; then
    db_user="$(ai_worker_env_value "$main" POSTGRES_USER)"; db_pass="$(ai_worker_env_value "$main" POSTGRES_PASSWORD)"
    db_name="$(ai_worker_env_value "$main" POSTGRES_DB)"; db_port="$(ai_worker_env_value "$main" DB_HOST_PORT)"
    DB_URL="postgres://${db_user:-jobradar}:${db_pass:-jobradar}@127.0.0.1:${db_port:-5433}/${db_name:-jobradar}"
  fi
  printf '%s\n' "$DB_URL"
  return 0
}

# sd_env_decode <s>: the exact inverse of the install script's sd_env (a double-quoted Environment= value): \\ -> \,
# \" -> ", %% -> %. Any other backslash sequence, a lone or other % sequence, or an unescaped " is not something sd_env
# writes: 1. Scans character by character; nothing is evaluated or expanded.
sd_env_decode() {
  local s="$1" out="" i=0 c n
  while (( i < ${#s} )); do
    c="${s:i:1}"; n="${s:i+1:1}"
    case "$c" in
      '\') case "$n" in '\'|'"') out+="$n"; i=$((i+2)); continue ;; *) return 1 ;; esac ;;
      '%') [[ "$n" == '%' ]] || return 1; out+='%'; i=$((i+2)); continue ;;
      '"') return 1 ;;
    esac
    out+="$c"; i=$((i+1))
  done
  printf '%s' "$out"
}

# sd_path_decode <s>: the exact inverse of sd_path (WorkingDirectory=): %% -> %; any other % sequence: 1.
sd_path_decode() {
  local s="$1" out="" i=0 c n
  while (( i < ${#s} )); do
    c="${s:i:1}"; n="${s:i+1:1}"
    if [[ "$c" == '%' ]]; then
      [[ "$n" == '%' ]] || return 1
      out+='%'; i=$((i+2)); continue
    fi
    out+="$c"; i=$((i+1))
  done
  printf '%s' "$out"
}

# sd_unit_db_url <unit file>: the DATABASE_URL of a unit the install script wrote. Exactly one line may set it, and it
# must be the generated form Environment="DATABASE_URL=<sd_env value>"; anything else: 1. Prints the decoded URL.
sd_unit_db_url() {
  local file="$1" count line value
  [[ -f "$file" && -r "$file" ]] || return 1
  count="$(grep -c 'DATABASE_URL=' "$file" 2>/dev/null)" || count=0
  [[ "$count" == 1 ]] || return 1
  line="$(grep 'DATABASE_URL=' "$file")" || return 1
  [[ "$line" == 'Environment="DATABASE_URL='*'"' ]] || return 1
  value="${line#'Environment="DATABASE_URL='}"
  value="${value%'"'}"
  sd_env_decode "$value"
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
