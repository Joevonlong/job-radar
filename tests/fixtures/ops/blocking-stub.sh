#!/usr/bin/env bash
# A deploy step that blocks until the test drops a "continue" file. Lines in $DEPLOY_TEST_LOG, prefixed with "# $BLOCK_NAME"
# (the "#" keeps them apart from the logged stub calls):
#   started pgid=<its process group>   when it starts
#   signal <INT|TERM|HUP>              for every signal it receives (it keeps running)
#   rollback                           BLOCK_COOPERATIVE=1 only: on TERM, then sleeps BLOCK_ROLLBACK_SLEEP and exits 1
#   grandchild done                    BLOCK_GRANDCHILD=<seconds>: a child in the same group writes it after that delay;
#                                      it ignores INT, TERM and HUP (a child that takes its time to finish), so a test can
#                                      check that the caller waits for the whole group
#   exit ctx=<0|1> lock=<0|1>          when it ends: whether $JOB_RADAR_BUILD_CONTEXT and $BLOCK_LOCK still exist
# BLOCK_CONTINUE is the file it waits for; BLOCK_EXIT its exit code (default 0).
name="${BLOCK_NAME:-block}"
log() { echo "# $name $*" >> "$DEPLOY_TEST_LOG"; }
exists() { if [[ -n "$1" && -d "$1" ]]; then echo 1; else echo 0; fi; }
report() { log "exit ctx=$(exists "${JOB_RADAR_BUILD_CONTEXT:-}") lock=$(exists "${BLOCK_LOCK:-}")"; }
on_signal() {
  log "signal $1"
  if [[ "${BLOCK_COOPERATIVE:-0}" == 1 && "$1" == TERM ]]; then
    log rollback; sleep "${BLOCK_ROLLBACK_SLEEP:-0}"; report; exit 1
  fi
}
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP
log "started pgid=$(ps -o pgid= -p $$ | tr -d ' ')"
if [[ -n "${BLOCK_GRANDCHILD:-}" ]]; then
  ( trap '' INT TERM HUP; sleep "$BLOCK_GRANDCHILD"; log "grandchild done" ) &
fi
while [[ ! -e "$BLOCK_CONTINUE" ]]; do sleep 0.05; done
report
exit "${BLOCK_EXIT:-0}"
