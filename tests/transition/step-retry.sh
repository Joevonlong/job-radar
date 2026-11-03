# shellcheck shell=bash
# shellcheck disable=SC2154,SC2034  # root, die and the FONT_RETRY_* settings come from run.sh; LAST_LOG is read there
# Sourced by tests/transition/run.sh (and by its test): logged <label> <want rc list> <command...>
# Runs the command with its output in step-<n>-<label>.log (and on the console) and dies when the exit code is not wanted.
# Needs $root (the log directory), die(), and FONT_RETRY_MAX / FONT_RETRY_BACKOFF (set in run.sh).
#
# Retry: the images of historical commits fetch Google Fonts while they build (next/font/google), which fails now and then
# with a module-not-found error on internal/font/google. When RETRY_FONT_FETCH=1 is set for the call, an unwanted exit
# whose output contains that name is retried up to FONT_RETRY_MAX more times, sleeping FONT_RETRY_BACKOFF seconds times
# the attempt number first; every retry is announced. Any other failure dies at once, as does the last attempt. A repeated
# deploy is safe: the build runs before anything is switched, and a failed build changes nothing (scenario D checks it).
STEP=0
FONT_SIGNATURE="internal/font/google"
logged() {
  local label="$1" want="$2" rc attempt=0 log
  shift 2
  STEP=$((STEP + 1))
  while :; do
    rc=0
    log="$root/step-$(printf '%02d' "$STEP")-$label.log"
    ((attempt == 0)) || log="$root/step-$(printf '%02d' "$STEP")-$label-try$((attempt + 1)).log"
    ((attempt > 0)) || echo "-- step $STEP: $label: $*"
    "$@" > "$log" 2>&1 || rc=$?
    tail -n 40 "$log"
    [[ " $want " == *" $rc "* ]] && break
    if [[ "${RETRY_FONT_FETCH:-}" == 1 ]] && grep -qF -- "$FONT_SIGNATURE" "$log" && ((attempt < FONT_RETRY_MAX)); then
      attempt=$((attempt + 1))
      echo "-- step $STEP ($label): RETRY $attempt/$FONT_RETRY_MAX: exit $rc with a Google Fonts fetch failure ($FONT_SIGNATURE) in the build; waiting $((FONT_RETRY_BACKOFF * attempt))s" >&2
      sleep $((FONT_RETRY_BACKOFF * attempt))
      continue
    fi
    die "step $STEP ($label): exit $rc, expected one of: $want (full output: $log)"
  done
  ((attempt == 0)) || echo "-- step $STEP ($label): passed on attempt $((attempt + 1)) after $attempt Google Fonts fetch failure(s)" >&2
  LAST_LOG="$log"
}
