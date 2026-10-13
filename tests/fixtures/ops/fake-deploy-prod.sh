#!/usr/bin/env bash
# Stands in for a calling script that holds the deploy lock (as a production wrapper does): sources the real proc.sh and
# releases.sh, takes the lock, writes its in-flight record, starts deploy.sh as a cooperative child with the lock token,
# and releases the lock in its exit handler. Lines in $DEPLOY_TEST_LOG: "# helper deploy rc=<n>", "# helper release rc=<n>".
#   fake-deploy-prod.sh <lib dir> <checkout> <deploy.sh> [deploy.sh arguments...]
set -euo pipefail
lib="$1" main="$2" deploy="$3"
shift 3
# shellcheck source=/dev/null
source "$lib/proc.sh"
# shellcheck source=/dev/null
source "$lib/releases.sh"
PROC_RC_ALLOWED="0 1 2 3 4"

on_exit() {
  local rc=$? lrc
  set +e
  [[ -z "$PROC_PGID" ]] || proc_group_wait "$PROC_PGID"
  lrc=0; releases_lock_release "$main" || lrc=$?
  echo "# helper release rc=$lrc" >> "$DEPLOY_TEST_LOG"
  (( lrc == 3 )) && rc=3
  exit "$(proc_exit_rc "$rc")"
}
proc_traps on_exit

releases_lock_acquire "$main" || { releases_lock_report "$main" >&2; exit 1; }
releases_inflight_register "$main" fake-deploy-prod.sh
cd "$main"
rc=0
proc_run --cooperative "$deploy" "$@" || rc=$?
echo "# helper deploy rc=$rc" >> "$DEPLOY_TEST_LOG"
proc_check_stop
case "$rc" in 0) exit 0 ;; 2) exit 4 ;; *) exit 3 ;; esac
