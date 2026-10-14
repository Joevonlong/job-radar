# shellcheck shell=bash
# The final exit code of scripts/ops/deploy.sh, decided in one place (sourced; no side effects).
#
#   deploy_final_rc <config writes pending: 0|1> <doctor exit code>
#
# A failed step never gets here: it exits 1 on the spot. Otherwise:
#   1. config writes pending (a user config write was skipped or failed, or more are due) -> 2, whatever the doctor said;
#   2. else the doctor: 0 or 1 (warnings only) -> 0, 2 (problems) -> 2, anything else (the doctor itself did not run,
#      for example 127) -> 1.
deploy_final_rc() {   # $1 = CONFIG_WRITES_PENDING, $2 = DOCTOR_RC; worker/deploy failures never get here (fail_step exits 1)
  if [[ "$1" == 1 ]]; then echo 2; return; fi
  case "$2" in 0|1) echo 0 ;; 2) echo 2 ;; *) echo 1 ;; esac
}
