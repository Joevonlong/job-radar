#!/usr/bin/env bash
# Shell cases for scripts/ops/lib/proc.sh. Run with the bash under test: `bash tests/ops/proc-lib/cases.sh` (the vitest suite
# runs it with /bin/bash; CI also runs it in the bash:3.2 and bash:5.2 images). Prints "ok - <case>" or "FAIL: <case>: ..."
# and exits 1 when any case failed.
#
# Tools: bash itself, and sh, uname, sleep (with sub-second values), cat, tr, grep, mktemp, rm, seq; /proc on Linux, ps on
# macOS. That is all the official bash images (alpine, busybox) have: no ps -o / -p, no script, perl, node. A missing tool
# is a failure, never a skip. PROC_SH overrides the library under test.
set -uo pipefail

missing() { echo "FAIL: missing $1"; exit 1; }
for tool in bash sh uname sleep cat tr grep mktemp rm seq; do command -v "$tool" >/dev/null 2>&1 || missing "$tool"; done
OS="$(uname -s)"
case "$OS" in
  Linux)
    [[ -r /proc/self/stat ]] || missing "/proc (readable /proc/self/stat)"
    sleep 0.05 || missing "sleep 0.05 (sub-second sleep)"
    ;;
  Darwin)
    command -v ps >/dev/null 2>&1 || missing ps
    [[ -n "$(ps -o args= -p $$ 2>/dev/null)" ]] || missing "ps -o args= -p"
    [[ -n "$(ps -o pgid= -p $$ 2>/dev/null)" ]] || missing "ps -o pgid= -p"
    ;;
  *) echo "FAIL: unsupported system $OS"; exit 1 ;;
esac

HERE="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
PROC_SH="${PROC_SH:-$HERE/../../../scripts/ops/lib/proc.sh}"
[[ -r "$PROC_SH" ]] || { echo "FAIL: cannot read $PROC_SH"; exit 1; }
BASH_BIN="$BASH"
export PROC_SH OS
echo "# bash $BASH_VERSION ($BASH_BIN) on $OS; library $PROC_SH"

# Process information without a full ps: /proc on Linux, ps on macOS.
proc_cmdline() { if [[ "$OS" == Linux ]]; then tr '\0' ' ' < "/proc/$1/cmdline"; else ps -o args= -p "$1"; fi; }
proc_pgid() {
  local stat
  if [[ "$OS" == Linux ]]; then
    stat="$(cat "/proc/$1/stat")"; stat="${stat##*)}"
    # shellcheck disable=SC2086  # split the fields after the command name
    set -- $stat; echo "$3"
  else
    ps -o pgid= -p "$1" | tr -d ' '
  fi
}
wait_file() { local i; for i in $(seq 200); do [[ -e "$1" ]] && return 0; sleep 0.05; done; return 1; }        # up to 10 s
wait_grep() { local i; for i in $(seq 200); do grep -q -- "$2" "$1" 2>/dev/null && return 0; sleep 0.05; done; return 1; }
export -f proc_cmdline proc_pgid wait_file wait_grep

FAILED=0
ok() { echo "ok - $1"; }
fail() { echo "FAIL: $1: $2"; FAILED=1; }
check() { if eval "$2"; then ok "$1"; else fail "$1" "${3:-expected $2}"; [[ -f "$T/rec" ]] && show_rec; fi; }
show_rec() { echo "  --- record:"; while IFS= read -r line; do echo "  | $line"; done < "$T/rec"; }
has() { grep -q -- "$1" "$T/rec" 2>/dev/null; }
count() { grep -c -- "$1" "$T/rec" 2>/dev/null || true; }
line_of() { grep -n -- "$1" "$T/rec" 2>/dev/null | { IFS=: read -r n _ && echo "$n"; } || true; }
before() { local a b; a="$(line_of "$1")"; b="$(line_of "$2")"; [[ -n "$a" && -n "$b" && "$a" -lt "$b" ]]; }

ROOT_T="$(mktemp -d "${TMPDIR:-/tmp}/proc-lib-cases.XXXXXX")"
trap 'rm -rf "$ROOT_T"' EXIT
fresh() { T="$(mktemp -d "$ROOT_T/case.XXXXXX")"; export T; }

# The script under test: `set -euo pipefail`, sources proc.sh, an on_exit like deploy.sh's (records, waits, a release stub
# whose status is RELEASE_RC, maps the exit code), a lock file that on_exit removes, then the body in $BODY.
PARENT="$ROOT_T/parent.sh"
cat > "$PARENT" <<'EOF'
set -euo pipefail
source "$PROC_SH"
rec() { echo "$*" >> "$T/rec"; }
fake_release() { return "${RELEASE_RC:-0}"; }
on_exit() {
  local rc=$? lrc
  set +e
  [[ -n "${CLEANED:-}" ]] && return; CLEANED=1
  [[ -z "$PROC_PGID" ]] || proc_group_wait "$PROC_PGID"
  rec "on_exit rc=$rc"
  eval "${ON_EXIT_EXTRA:-}"
  lrc=0; fake_release || lrc=$?
  (( lrc == 3 )) && rc=1
  rec "cleanup lock=$([[ -e "$T/lock" ]] && echo 1 || echo 0)"
  rm -f "$T/lock"
  exit "$(proc_exit_rc "$rc")"
}
proc_traps on_exit
: > "$T/lock"
eval "$BODY"
EOF

# A grandchild in the command's group: records a signal if one reaches it, and whether the lock still exists when it ends.
GRANDCHILD="$ROOT_T/grandchild.sh"
cat > "$GRANDCHILD" <<'EOF'
trap 'echo "grandchild signal" >> "$1/rec"' INT TERM HUP
: > "$1/started"
sleep 1
if [ -e "$1/lock" ]; then l=1; else l=0; fi
echo "grandchild done lock=$l" >> "$1/rec"
EOF
export GRANDCHILD

# run_bg: start the parent in its own process group (like a terminal's foreground job), so the case can signal that group.
run_bg() { set -m; BODY="$1" "$BASH_BIN" "$PARENT" & BG=$!; set +m; }
run_fg() { BODY="$1" "$BASH_BIN" "$PARENT"; }

# ---------------------------------------------------------------------------------------------------------------------
# A new process group: its id is the command's PID, not the script's; the script's own group does not change.
fresh
BODY='before="$(proc_pgid $$)"
( wait_file "$T/pid"; proc_pgid "$(cat "$T/pid")" > "$T/cmdpgid" ) & sampler=$!
proc_run sh -c '"'"'echo $$ > "$1/pid"; sleep 0.5; :'"'"' _ "$T"
wait "$sampler"
echo "self=$$ selfpgid=$before after=$(proc_pgid $$) cmd=$(cat "$T/pid") cmdpgid=$(cat "$T/cmdpgid")" > "$T/out"'
run_fg "$BODY" >/dev/null 2>&1
read -r self selfpgid after cmd cmdpgid < "$T/out" 2>/dev/null || true
check "new process group: group id is the command's PID" '[[ "${cmdpgid#cmdpgid=}" == "${cmd#cmd=}" && -n "${cmd#cmd=}" ]]' "got $cmd $cmdpgid"
check "new process group: not the script's group, which is unchanged" '[[ "${selfpgid#selfpgid=}" != "${cmdpgid#cmdpgid=}" && "${selfpgid#selfpgid=}" == "${after#after=}" ]]' "got $self $selfpgid $after $cmdpgid"

# Pipelines and grandchildren: a signal to the script's group never reaches them; proc_run returns only after they end;
# the lock exists until then; no further step; the exit code is the signal's.
pipe_body='rc=0; proc_run bash -c '"'"'sh "$GRANDCHILD" "$1" | cat'"'"' _ "$T" || rc=$?; rec "returned rc=$rc"; proc_check_stop; rec "next step"'
launcher_body='rc=0; proc_run bash -c '"'"'sh "$GRANDCHILD" "$1" & exit 3'"'"' _ "$T" || rc=$?; rec "returned rc=$rc"; proc_check_stop; rec "next step"'
for sig in INT TERM HUP; do
  case "$sig" in INT) want=130 ;; TERM) want=143 ;; HUP) want=129 ;; esac
  for shape in pipe launcher; do
    fresh
    if [[ "$shape" == pipe ]]; then body="$pipe_body"; else body="$launcher_body"; fi
    run_bg "$body" 2>/dev/null
    wait_file "$T/started" || fail "$shape $sig" "the grandchild never started"
    kill "-$sig" -- "-$BG" 2>/dev/null
    rc=0; wait "$BG" || rc=$?
    check "$shape, $sig to the script's group: exit $want" '[[ "$rc" == "$want" ]]' "exit $rc"
    check "$shape, $sig: the grandchild got no signal and finished while the lock existed" '! has "grandchild signal" && has "grandchild done lock=1"'
    check "$shape, $sig: proc_run returned after the grandchild, cleanup after that, no next step" 'before "grandchild done" "returned rc=" && before "returned rc=" "cleanup lock=1" && ! has "next step"'
  done
done

# Without a signal: proc_run also waits for the grandchild, then returns the command's own status.
fresh
run_fg "$launcher_body" >/dev/null 2>&1; rc=$?
check "no signal: proc_run waits for the grandchild and returns the command's status" 'before "grandchild done" "returned rc=3" && has "next step" && [[ "$rc" == 0 ]]' "exit $rc"

# After a signal, proc_run keeps polling until the command ends, takes its real status; proc_check_stop then exits.
fresh
run_bg 'rc=0; proc_run sh -c '"'"': > "$1/started"; sleep 0.6; echo "first done" >> "$1/rec"; exit 4'"'"' _ "$T" || rc=$?; rec "returned rc=$rc"; proc_check_stop; proc_run sh -c '"'"'echo "second started" >> "$1/rec"'"'"' _ "$T"' 2>/dev/null
wait_file "$T/started"; kill -TERM -- "-$BG"; rc=0; wait "$BG" || rc=$?
check "signal during a command: it runs to its end, its status is kept, the next command does not start" 'before "first done" "returned rc=4" && ! has "second started" && [[ "$rc" == 143 ]]' "exit $rc"

# Cooperative: the first signal sends one TERM to the child's group; the child rolls back; later signals are not forwarded.
CHILD="$ROOT_T/coop-child.sh"
cat > "$CHILD" <<'EOF'
got=0
trap 'got=$((got + 1)); echo "child TERM" >> "$1/rec"' TERM
: > "$1/started"
while [ "$got" -eq 0 ]; do sleep 0.05; done
echo "rollback 1" >> "$1/rec"
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do sleep 0.05; done
echo "rollback 2" >> "$1/rec"
exit 1
EOF
export CHILD
fresh
run_bg 'rc=0; proc_run --cooperative bash "$CHILD" "$T" || rc=$?; rec "returned rc=$rc abnormal=$PROC_CHILD_ABNORMAL"; proc_check_stop; rec "next step"' 2>/dev/null
wait_file "$T/started"; kill -HUP -- "-$BG"
wait_grep "$T/rec" "rollback 1"; kill -HUP -- "-$BG"
rc=0; wait "$BG" || rc=$?
check "cooperative: one TERM to the child, rollback finished, parent exits 129" '[[ "$(count "child TERM")" == 1 ]] && before "rollback 2" "returned rc=1 abnormal=0" && ! has "next step" && [[ "$rc" == 129 ]]' "exit $rc"

# on_exit runs once; with a signal recorded, the exit code stays the signal's even when a later command fails.
fresh
run_bg 'proc_run sh -c '"'"': > "$1/started"; sleep 0.3'"'"' _ "$T"; false; rec "after false"' 2>/dev/null
wait_file "$T/started"; kill -INT -- "-$BG"; rc=0; wait "$BG" || rc=$?
check "on_exit once, signal code kept after a failing command" '[[ "$(count "on_exit")" == 1 && "$rc" == 130 ]] && ! has "after false"' "exit $rc"

# Exit-code normalisation.
for pair in "exit 0:0" "exit 1:1" "exit 2:2" "exit 5:1" "sh -c 'exit 128':1" "kill -TERM \$\$; exit 5:143"; do
  body="${pair%:*}"; want="${pair##*:}"
  fresh; run_fg "$body" >/dev/null 2>&1; rc=$?
  check "normalise: $body -> $want" '[[ "$rc" == "$want" ]]' "exit $rc"
done
for pair in "exit 3:3" "exit 4:4" "exit 5:1"; do
  body="${pair%:*}"; want="${pair##*:}"
  fresh; run_fg "PROC_RC_ALLOWED=\"0 1 2 3 4\"; $body" >/dev/null 2>&1; rc=$?
  check "normalise with PROC_RC_ALLOWED=\"0 1 2 3 4\": $body -> $want" '[[ "$rc" == "$want" ]]' "exit $rc"
done
fresh; PROC_RC_ALLOWED="0 1 2 3 4 5" run_fg "exit 5" >/dev/null 2>&1; rc=$?
check "PROC_RC_ALLOWED from the environment is ignored" '[[ "$rc" == 1 ]]' "exit $rc"

# The exit handler is not cut short by set -e: a failing command and a release that keeps the lock (3) -> 1, or the signal's.
fresh; ON_EXIT_EXTRA='false; rec "after false"' RELEASE_RC=3 run_fg 'exit 0' >/dev/null 2>&1; rc=$?
check "on_exit: a failing command and release 3 -> later steps run, exit 1" 'has "after false" && has "cleanup lock=" && [[ "$rc" == 1 ]]' "exit $rc"
fresh; ON_EXIT_EXTRA='false; rec "after false"' RELEASE_RC=3 run_fg 'kill -HUP $$; exit 0' >/dev/null 2>&1; rc=$?
check "on_exit: release 3 with a signal recorded -> the signal's code" 'has "after false" && [[ "$rc" == 129 ]]' "exit $rc"

# Pipelines need -o pipefail inside the new bash.
fresh; run_fg 'rc=0; proc_run bash -o pipefail -c "false | cat" || rc=$?; rec "pipefail rc=$rc"; rc=0; proc_run bash -c "false | cat" || rc=$?; rec "plain rc=$rc"' >/dev/null 2>&1
check "pipeline: bash -o pipefail -c 'false | cat' fails, without it it does not" 'has "pipefail rc=1" && has "plain rc=0"'

# A cooperative child's status: anything but 0 1 2 129 130 143 means its on_exit did not run.
fresh; run_fg 'rc=0; proc_run --cooperative sh -c "kill -9 \$\$" || rc=$?; rec "rc=$rc abnormal=$PROC_CHILD_ABNORMAL"' >/dev/null 2>&1
check "cooperative child killed with -9: PROC_CHILD_ABNORMAL=1" 'has "rc=137 abnormal=1"'
for c in 0 1 2 129 130 143; do
  fresh; run_fg "rc=0; proc_run --cooperative sh -c 'exit $c' || rc=\$?; rec \"rc=\$rc abnormal=\$PROC_CHILD_ABNORMAL\"" >/dev/null 2>&1
  check "cooperative child exits $c: PROC_CHILD_ABNORMAL=0" "has \"rc=$c abnormal=0\""
done

# Race: the child signals the parent, then is killed (60 times): always abnormal, never the 143 of an interrupted wait.
fresh
run_fg 'for i in $(seq 60); do
  PROC_CHILD_ABNORMAL=0; STOPPING=0; STOP_SIGNAL=""; PROC_FORWARDED=0
  rc=0; proc_run --cooperative sh -c "kill -TERM \$PPID; kill -9 \$\$" || rc=$?
  rec "race rc=$rc abnormal=$PROC_CHILD_ABNORMAL"
done
STOPPING=0; STOP_SIGNAL=""' >/dev/null 2>&1
check "race (signal, then kill -9) x60: abnormal every time, never 143" '[[ "$(count "^race rc=")" == 60 && "$(count "abnormal=1")" == 60 ]] && ! has "race rc=143"' "$(count "abnormal=1")/60 abnormal, $(count "race rc=143") x 143"

# Race: the child signals the parent, then exits 1 normally (60 runs): proc_run returns 1, not abnormal; the parent exits 143.
bad=0
for i in $(seq 60); do
  fresh
  run_fg 'rc=0; proc_run --cooperative sh -c "kill -TERM \$PPID; exit 1" || rc=$?; rec "rc=$rc abnormal=$PROC_CHILD_ABNORMAL"; proc_check_stop' >/dev/null 2>&1; rc=$?
  if ! has "rc=1 abnormal=0" || [[ "$rc" != 143 ]] || ! has "cleanup lock=1" || [[ -e "$T/lock" ]]; then
    bad=$((bad + 1)); [[ "$bad" -gt 1 ]] || { echo "  first bad run: exit $rc"; show_rec; }
  fi
done
check "race (signal, then exit 1) x60: returns 1, not abnormal, parent 143, lock released" '[[ "$bad" == 0 ]]' "$bad of 60 runs wrong"

# POSIX mode is refused before any function or trap exists and before any command runs.
for how in env posix; do
  fresh
  if [[ "$how" == env ]]; then
    out="$(POSIXLY_CORRECT=1 BODY='rec body' "$BASH_BIN" "$PARENT" 2>&1)"; rc=$?
  else
    out="$(BODY='rec body' "$BASH_BIN" --posix "$PARENT" 2>&1)"; rc=$?
  fi
  check "POSIX mode ($how) refused: exit 1, hint, nothing run" '[[ "$rc" == 1 ]] && [[ "$out" == *"unset POSIXLY_CORRECT"* && "$out" == *"not sh or bash --posix"* ]] && [[ ! -e "$T/rec" ]]' "exit $rc, output: $out"
done

# Extra environment for one command: VAR=value proc_run ...: the child sees it, it is in no argv, it is gone afterwards,
# and proc_run still updates this shell's variables.
fresh
run_fg '( wait_file "$T/pid"; proc_cmdline "$(cat "$T/pid")" > "$T/cmdline" ) & sampler=$!
X=secret-value-42 proc_run --cooperative sh -c '"'"'echo $$ > "$1/pid"; echo "X=$X" > "$1/seen"; sleep 0.4; :'"'"' _ "$T"
wait "$sampler"
rec "after X=${X-unset} pgid=${PROC_PGID:-empty}"
X=secret-value-42 proc_run --cooperative sh -c "kill -9 \$\$" || true
rec "abnormal=$PROC_CHILD_ABNORMAL"' >/dev/null 2>&1
check "prefix assignment: the child sees X" '[[ "$(cat "$T/seen" 2>/dev/null)" == "X=secret-value-42" ]]'
check "prefix assignment: the value is not in the child's command line" '[[ -s "$T/cmdline" ]] && ! grep -q secret-value-42 "$T/cmdline"' "command line: $(cat "$T/cmdline" 2>/dev/null)"
check "prefix assignment: X is unset afterwards, PROC_PGID and PROC_CHILD_ABNORMAL updated in this shell" 'has "after X=unset pgid=empty" && has "abnormal=1"'

echo
if [[ "$FAILED" == 0 ]]; then echo "all proc.sh cases passed (bash $BASH_VERSION)"; else echo "some proc.sh cases FAILED (bash $BASH_VERSION)"; fi
exit "$FAILED"
