# shellcheck shell=bash
# Process groups, signals and exit codes for the deploy scripts. Source it once, near the top, from a bash script
# (bash 3.2 or later, never in POSIX mode). Self-contained: no other file is sourced, nothing outside bash and the
# standard tools (kill, sleep, stty, grep) is used.
#
# Rules:
#   - Signals (INT, TERM, HUP) only record the first signal and set STOPPING=1; the handler does not clean up, does
#     not release a lock, does not exit and, by default, forwards nothing.
#   - Every state-changing command runs through proc_run in its own process group (set -m; the group id is its PID),
#     with stdin from /dev/null. The terminal's INT / HUP go to the foreground group and never reach it; pipelines,
#     `sh -c` and the processes pnpm starts stay in that group. proc_run waits until the command and its whole group
#     are gone, then returns the command's exit status.
#   - Without set -m, bash would start background commands with SIGINT ignored; with it they keep the default, but the
#     terminal cannot reach them anyway (a background script started without job control also ignores INT: that is why
#     a cooperative parent forwards TERM, not INT).
#   - After proc_run, call proc_check_stop: with a signal recorded it exits with that signal's code (INT 130, TERM 143,
#     HUP 129) before the next step starts; otherwise the step's own status decides.
#   - --cooperative children (scripts that follow these same rules) get one TERM to their whole group on the first
#     signal; later signals are only recorded. PROC_FORWARDED is never reset: each script has at most one
#     cooperative child, so one TERM per script is enough.
#   - Exit codes: on_exit maps a non-signal status outside PROC_RC_ALLOWED to 1, so a script that ran its on_exit can
#     only end with an allowed code or 129 / 130 / 143. A --cooperative child that ends with anything else did not run
#     its on_exit (for example SIGKILL -> 137): PROC_CHILD_ABNORMAL=1, and the lock release keeps the lock.
#   - Extra environment for one command: `VAR=value proc_run cmd ...` (exported to cmd only, never in any argv, gone
#     afterwards). Never hand proc_run an `env VAR=value cmd` (the value shows in env's argv), never wrap proc_run in a subshell
#     (PROC_PGID / PROC_CHILD_ABNORMAL would not come back and the traps are reset there), no wrapper shell (if one is
#     unavoidable, `exec` inside it).
#   - Pipelines: `proc_run bash -o pipefail -c '...' _ <args...>` (a new bash does not inherit an unexported pipefail).
#   - Cleanup hangs on EXIT only (proc_traps): never another `trap ... EXIT` or `trap - EXIT`. on_exit records $?, then
#     `set +e`, waits for PROC_PGID, captures the lock release status explicitly, and exits with proc_exit_rc.
#   - Waiting has no upper limit: a command that leaves a process behind in its group keeps the script waiting. That is
#     deliberate: waiting is safer than releasing a lock while something still changes state.

# Bash's POSIX mode breaks both `wait` on an ended child (127) and prefix assignments (bash 3.2 keeps them).
if shopt -oq posix; then echo "proc.sh: POSIX mode is not supported; unset POSIXLY_CORRECT and run with bash, not sh or bash --posix" >&2; exit 1; fi

STOPPING=0; STOP_SIGNAL=""; PROC_PGID=""; PROC_COOP=0; PROC_FORWARDED=0; PROC_STEP=""
PROC_RC_ALLOWED="0 1 2"; PROC_CHILD_ABNORMAL=0   # scripts that allow more assign it after sourcing, never from the environment

proc_on_signal() {   # the trap of INT, TERM, HUP: record, forward once to a cooperative child, return
  STOPPING=1; [[ -n "$STOP_SIGNAL" ]] || STOP_SIGNAL="$1"
  if [[ -n "$PROC_PGID" ]]; then
    if [[ "$PROC_COOP" == 1 && "$PROC_FORWARDED" == 0 ]]; then
      PROC_FORWARDED=1; kill -TERM -- "-$PROC_PGID" 2>/dev/null || true
    else
      echo "stopping after this step ($PROC_STEP, process group $PROC_PGID); to abort it now: kill -TERM -$PROC_PGID" >&2 || true
    fi
  fi
  return 0
}

proc_signal_rc() { case "$STOP_SIGNAL" in INT) echo 130 ;; TERM) echo 143 ;; HUP) echo 129 ;; *) echo 0 ;; esac; }

proc_traps() {   # proc_traps <exit handler>
  trap 'proc_on_signal INT' INT; trap 'proc_on_signal TERM' TERM; trap 'proc_on_signal HUP' HUP
  trap "$1" EXIT
}

proc_group_wait() {   # until no process is left in group $1
  local said=0
  while kill -0 -- "-$1" 2>/dev/null; do
    (( said )) || { echo "waiting for the remaining processes in group $1" >&2 || true; said=1; }
    sleep 0.2 || true   # the sleep itself may be hit by a terminal signal
  done
}

proc_run() {   # proc_run [--cooperative] <cmd> [args...]: returns the command's exit status
  local coop=0 rc; if [[ "${1:-}" == --cooperative ]]; then coop=1; shift; fi
  PROC_STEP="${STEP_NAME:-$1}"
  set -m; "$@" </dev/null & PROC_PGID=$!; set +m
  PROC_COOP=$coop
  if [[ "$STOPPING" == 1 ]]; then proc_on_signal "$STOP_SIGNAL"; fi   # signal arrived just before the spawn
  # Poll, then wait once: never loop on a wait a trap interrupted (bash 5.2 returns 255 if the child ends there).
  # The poll forks `sleep` about 20 times a second; negligible next to a build or a migration.
  while kill -0 "$PROC_PGID" 2>/dev/null; do sleep 0.05 || true; done
  rc=0; wait "$PROC_PGID" || rc=$?   # the child has ended: take its real status (`|| rc=$?` keeps set -e quiet)
  proc_group_wait "$PROC_PGID"
  if (( coop )); then case " 0 1 2 129 130 143 " in *" $rc "*) ;; *) PROC_CHILD_ABNORMAL=1 ;; esac; fi
  PROC_PGID=""; PROC_COOP=0
  return "$rc"
}

proc_check_stop() { [[ "$STOPPING" == 1 ]] || return 0; exit "$(proc_signal_rc)"; }

proc_exit_rc() {   # proc_exit_rc <status recorded at the top of on_exit>
  if [[ -n "$STOP_SIGNAL" ]]; then proc_signal_rc; return; fi
  case " $PROC_RC_ALLOWED " in *" $1 "*) echo "$1" ;; *) echo 1 ;; esac
}

proc_tostop_set() {   # 0 when a terminal on stdout or stderr has tostop set
  local fd
  for fd in 1 2; do
    [[ -t $fd ]] || continue
    { stty -a 2>/dev/null | grep -Eq '(^|[^-])tostop'; } <&"$fd"   # redirect before the pipe replaces stdout
    return
  done
  return 1
}
