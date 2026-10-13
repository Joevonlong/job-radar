# shellcheck shell=bash
# The release lock and its in-flight records: one deployment at a time on a checkout. Source it once, near the top.
#
# The lock is the directory <main>/data/releases/ai-worker/.lock/ (mkdir is atomic). It holds:
#   owner         exactly four lines: token=<32 lowercase hex>, pid=<decimal>, host=<hostname -s>, started=<UTC epoch s>
#                 (written as owner.tmp, then renamed); no other line is allowed
#   inflight/<pid>  one record per script working under the lock: script=<name>, pid=<its PID>, started=<UTC epoch s>
#                 (written as inflight/.tmp-<pid>, then renamed)
# Both formats are an interface: the production wrapper of the maintainers implements the same lock and reads and writes
# the same files.
#
# Ownership: RELEASES_LOCK_MINE (never exported) is 0 after sourcing; only the mkdir in releases_lock_acquire sets it to
# 1. Checking a token never changes it, and only the process with RELEASES_LOCK_MINE=1 (the one that took the lock)
# releases it. A child started with the exported JOB_RADAR_RELEASES_LOCK_TOKEN re-enters the lock and does not own it.
#
# A record that is still there means the script that wrote it did not confirm that the process groups it started have
# ended (it was killed with SIGKILL, so its exit handler never ran). Any entry in inflight/ counts, an unreadable file
# or a half-written .tmp-<pid> too; the PID in a record is only shown (PIDs are reused). When the owner finds another
# record (or PROC_CHILD_ABNORMAL=1 from proc.sh) at release, it keeps the lock and its temporary directories and
# returns 3. A lock is never taken over automatically: the report says how to check and clear it.

RELEASES_LOCK_MINE=0
RELEASES_INFLIGHT_MINE=0
RELEASES_LOCK_TOKEN_MINE=""

# The command that finds what a killed script left running; printed as is, so it can be copied.
RELEASES_PS_COMMAND="ps -A -o pid,ppid,pgid,etime,command | grep -E '[d]ocker compose|[p]npm|[m]igrate|[c]onfig[:-]|[o]ps:drain|[p]repare-release|[i]nstall-ai-worker|[l]aunchctl|[s]ystemctl'"

releases_lock_dir() { echo "$1/data/releases/ai-worker/.lock"; }   # releases_lock_dir <main>

# releases_lock_owner_read <main>: prints the owner file when it has exactly the four lines in order, else returns 1.
releases_lock_owner_read() {
  local file line n=0 out=""
  file="$(releases_lock_dir "$1")/owner"
  [[ -f "$file" && ! -L "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    case "$n" in
      1) [[ "$line" =~ ^token=[0-9a-f]{32}$ ]] || return 1 ;;
      2) [[ "$line" =~ ^pid=[0-9]+$ ]] || return 1 ;;
      3) [[ "$line" =~ ^host=[^[:space:]]+$ ]] || return 1 ;;
      4) [[ "$line" =~ ^started=[0-9]+$ ]] || return 1 ;;
      *) return 1 ;;
    esac
    out="$out$line"$'\n'
  done < "$file"
  [[ "$n" -eq 4 ]] || return 1
  printf '%s' "$out"
}

# releases_owner_field <owner text> <key>: one value of an owner (or record) text.
releases_owner_field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -n 1; }

releases_pid_alive() { [[ "$1" =~ ^[0-9]+$ ]] && ps -p "$1" >/dev/null 2>&1; }

# releases_lock_acquire <main>: 0 = holding the lock (taken now, or re-entered with the inherited token); 1 = refused.
releases_lock_acquire() {
  local main="$1" lock owner token host
  lock="$(releases_lock_dir "$main")"
  mkdir -p "$main/data/releases/ai-worker" || { echo "releases: cannot create $main/data/releases/ai-worker" >&2; return 1; }
  if [[ -n "${JOB_RADAR_RELEASES_LOCK_TOKEN:-}" ]]; then
    if owner="$(releases_lock_owner_read "$main")" && [[ "$(releases_owner_field "$owner" token)" == "$JOB_RADAR_RELEASES_LOCK_TOKEN" ]]; then
      return 0
    fi
    echo "releases: inherited lock token does not match $lock/owner" >&2
    return 1
  fi
  if ! mkdir "$lock" 2>/dev/null; then
    if owner="$(releases_lock_owner_read "$main")"; then
      echo "releases: $lock is held by pid $(releases_owner_field "$owner" pid) on $(releases_owner_field "$owner" host)" >&2
    else
      echo "releases: $lock is held (owner unknown)" >&2
    fi
    return 1
  fi
  RELEASES_LOCK_MINE=1
  mkdir "$lock/inflight" || { echo "releases: cannot create $lock/inflight" >&2; return 1; }
  token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "$token" =~ ^[0-9a-f]{32}$ ]] || { echo "releases: could not generate a lock token" >&2; return 1; }
  host="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"; host="${host%%[[:space:]]*}"; host="${host:-unknown}"
  printf 'token=%s\npid=%s\nhost=%s\nstarted=%s\n' "$token" "$$" "$host" "$(date -u +%s)" > "$lock/owner.tmp" \
    && mv "$lock/owner.tmp" "$lock/owner" || { echo "releases: cannot write $lock/owner" >&2; return 1; }
  RELEASES_LOCK_TOKEN_MINE="$token"
  export JOB_RADAR_RELEASES_LOCK_TOKEN="$token"
  return 0
}

# releases_lock_verify <main>: read-only; 0 when the exported token is the owner's. Never creates or changes anything.
releases_lock_verify() {
  local owner
  [[ -n "${JOB_RADAR_RELEASES_LOCK_TOKEN:-}" ]] || return 1
  owner="$(releases_lock_owner_read "$1")" || return 1
  [[ "$(releases_owner_field "$owner" token)" == "$JOB_RADAR_RELEASES_LOCK_TOKEN" ]]
}

# releases_inflight_register <main> <script>: writes this process's record; 1 when there is no inflight/ directory.
releases_inflight_register() {
  local dir
  dir="$(releases_lock_dir "$1")/inflight"
  [[ -d "$dir" && ! -L "$dir" ]] || { echo "releases: $dir does not exist (the lock was not taken by these rules)" >&2; return 1; }
  printf 'script=%s\npid=%s\nstarted=%s\n' "$2" "$$" "$(date -u +%s)" > "$dir/.tmp-$$" && mv "$dir/.tmp-$$" "$dir/$$" \
    || { echo "releases: cannot write $dir/$$" >&2; return 1; }
  RELEASES_INFLIGHT_MINE=1
}

# releases_inflight_entries <main>: the paths of every entry in inflight/ (dot files included), one per line.
releases_inflight_entries() {
  local dir f
  dir="$(releases_lock_dir "$1")/inflight"
  [[ -d "$dir" ]] || return 0
  for f in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [[ -e "$f" || -L "$f" ]] && printf '%s\n' "$f"
  done
  return 0
}

# releases_inflight_list <main>: one line per entry: "<name> <pid> <script> <started> <alive|gone>" for a record in
# the format, "<name> partial" for a half-written .tmp-*, "<name> unreadable" for anything else.
releases_inflight_list() {
  local f name text pid script started
  while IFS= read -r f; do
    name="${f##*/}"
    case "$name" in .tmp-*) echo "$name partial"; continue ;; esac
    text=""
    if [[ -f "$f" && ! -L "$f" ]]; then text="$(cat "$f" 2>/dev/null || true)"; fi
    pid="$(releases_owner_field "$text" pid)"; script="$(releases_owner_field "$text" script)"; started="$(releases_owner_field "$text" started)"
    if [[ "$(printf '%s\n' "$text" | wc -l | tr -d ' ')" == 3 && "$(printf '%s\n' "$text" | sed -n 1p)" == "script=$script" \
          && "$script" =~ ^[A-Za-z0-9._-]+$ && "$pid" =~ ^[0-9]+$ && "$started" =~ ^[0-9]+$ ]]; then
      if releases_pid_alive "$pid"; then echo "$name $pid $script $started alive"; else echo "$name $pid $script $started gone"; fi
    else
      echo "$name unreadable"
    fi
  done < <(releases_inflight_entries "$1")
}

# releases_lock_report <main>: the owner, every in-flight record and how to clear the lock. Never prints the token.
releases_lock_report() {
  local main="$1" lock owner pid host started now list
  lock="$(releases_lock_dir "$main")"
  echo "release lock: $lock"
  if owner="$(releases_lock_owner_read "$main")"; then
    pid="$(releases_owner_field "$owner" pid)"; host="$(releases_owner_field "$owner" host)"; started="$(releases_owner_field "$owner" started)"
    now="$(date -u +%s)"
    echo "  owner: pid $pid on $host, held for $((now - started)) s"
  else
    echo "  owner unknown (the owner file is missing or incomplete)"
  fi
  list="$(releases_inflight_list "$main")"
  if [[ -n "$list" ]]; then
    echo "  in-flight records (<file> <pid> <script> <started> <alive|gone>):"
    printf '%s\n' "$list" | sed 's/^/    /'
  else
    echo "  in-flight records: none"
  fi
  echo "  To clear it: first make sure no build, dependency install (pnpm install), migration, config write, drain or install is"
  echo "  still running (a killed script's own PID is gone; what it started can only be found like this):"
  echo "    $RELEASES_PS_COMMAND"
  echo "  then remove the lock:"
  echo "    rm -rf $lock"
}

# releases_lock_release <main>: call it only when every process group this script started with proc_run has ended.
# Removes this process's record first. Not the owner (or the owner file no longer has its token): 0, nothing else
# touched; that 0 only means "no unlock happened" and never allows deleting a temporary directory. The owner: another
# entry in inflight/ or PROC_CHILD_ABNORMAL=1 keeps everything in place and returns 3; otherwise the lock is removed, 0.
releases_lock_release() {
  local main="$1" lock owner
  lock="$(releases_lock_dir "$main")"
  if [[ "$RELEASES_INFLIGHT_MINE" == 1 ]]; then rm -f "$lock/inflight/$$"; RELEASES_INFLIGHT_MINE=0; fi
  [[ "$RELEASES_LOCK_MINE" == 1 ]] || return 0
  if ! owner="$(releases_lock_owner_read "$main")" || [[ "$(releases_owner_field "$owner" token)" != "$RELEASES_LOCK_TOKEN_MINE" ]]; then
    return 0
  fi
  if [[ -n "$(releases_inflight_entries "$main")" || "${PROC_CHILD_ABNORMAL:-0}" == 1 ]] || ! rmdir "$lock/inflight" 2>/dev/null; then
    echo "releases: descendant exit not confirmed; lock left in place" >&2
    [[ "${PROC_CHILD_ABNORMAL:-0}" != 1 ]] || echo "releases: a cooperative child ended without running its exit handler (killed?)" >&2
    releases_lock_report "$main" >&2
    return 3
  fi
  rm -f "$lock/owner" "$lock/owner.tmp"
  rmdir "$lock" 2>/dev/null || { echo "releases: could not remove $lock" >&2; return 3; }
  RELEASES_LOCK_MINE=0
  return 0
}
