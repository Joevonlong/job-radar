# shellcheck shell=bash
# The final exit code of scripts/ops/deploy.sh, decided in one place (sourced; no side effects).
#
#   deploy_final_rc <config writes pending: 0|1> <doctor exit code> [<worker wait: 0|1>]
#
# A failed step never gets here: it exits 1 on the spot. Otherwise:
#   1. config writes pending (a user config write was skipped or failed, or more are due) -> 2, whatever the doctor said;
#   2. else the doctor: 0 or 1 (warnings only) -> 0, 2 (problems) -> 2, anything else (the doctor itself did not run,
#      for example 127) -> 1. An unconfirmed worker overrides doctor 0 or 1 with the policy below.

# Set to 0 to make an unconfirmed worker a warning only.
DEPLOY_RC_WORKER_UNCONFIRMED=2
deploy_final_rc() {   # $1 = CONFIG_WRITES_PENDING, $2 = DOCTOR_RC, $3 = WORKER_WAIT_RC (optional); worker/deploy failures never get here (fail_step exits 1)
  if [[ "$1" == 1 ]]; then echo 2; return; fi
  case "$2" in 0|1) if [[ "${3:-0}" == 1 ]]; then echo "$DEPLOY_RC_WORKER_UNCONFIRMED"; else echo 0; fi ;; 2) echo 2 ;; *) echo 1 ;; esac
}
