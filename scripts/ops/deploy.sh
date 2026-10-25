#!/usr/bin/env bash
# Deploy / upgrade Job Radar on this machine. Safe to run again: every step is idempotent.
#
#   scripts/ops/deploy.sh [--dry-run] [--skip-pull] [--branch main | --ref v2.0.0 [--verify]] [--remote origin]
#                     [--no-backup] [--no-prune] [--no-ai-worker] [--no-drain] [--drain-timeout S]
#                     [--wait-timeout 300] [--settle S]
#
# Steps (each prints what it does; the first one that fails stops the script and says why):
#   1  preflight   the terminal does not stop background output (stty -tostop); takes the deploy lock
#                  data/releases/ai-worker/.lock (one deploy at a time; a second one stops here and says how to check and
#                  clear a lock that was left behind); removes build contexts and half-built release directories
#                  (.tmp-* / .trash-* under data/releases/ai-worker) of earlier deploys that did not finish;
#                  git, docker, node, pnpm are installed and Docker is running; no uncommitted changes to tracked files
#                  (in every mode, --skip-pull too); optional external-volume guard
#   2  pull        the checkout is on the branch and fast-forwards to <remote>/<branch>; then the target commit is fixed:
#                  every later step uses that commit, and a step stops when HEAD moved or tracked files changed meanwhile.
#                  With --ref, the resolved commit must ship an install script that runs the worker from a release
#                  directory (else see docs/upgrade.md, "Downgrade to a version before release directories")
#   3  install     pnpm install --frozen-lockfile
#   4  config      data/ folders exist; pnpm config:init (copies what the user config directory data/config lacks from the
#                  shipped defaults config/, never overwrites; the first layered run copies the whole live config),
#                  pnpm config:migrate --write (config_version upgrades, originals in data/config/.backup/),
#                  pnpm config:check; .env present; docker compose config
#   5  backup      scripts/ops/backup.sh --label pre-deploy (only when the db is already running)
#   6  build       git archive of the target commit into data/build/<commit>-<pid>, then docker compose -p job-radar build
#                  from it (JOB_RADAR_BUILD_CONTEXT): the images hold exactly the committed files, shipped config/ included;
#                  ignored, untracked or locally changed files never reach them
#   7  release     scripts/ops/prepare-release.sh <target commit>: the read-only release directory of the host ai-worker,
#                  data/releases/ai-worker/<commit> (reused when it is already there); the running worker is not touched
#   8  up          pnpm ops:drain (wait, bounded by schedule.yaml deploy.drain_timeout_seconds, for a running cycle to finish:
#                  recreating the runner would cut it off), then docker compose -p job-radar up -d --wait (db / web / runner /
#                  jobspy must turn healthy)
#   9  migrate     pnpm migrate:run (the runner migrates at start-up too; this checks it and is a no-op then)
#   10 ai-worker   scripts/ops/install-ai-worker.sh --release data/releases/ai-worker/<commit>: switches the service (a
#                  launchd agent on macOS, a systemd user unit on Linux) to that release; the new worker must show evidence
#                  in the database (instance lock and a heartbeat), else the old one is put back. An AI request the old
#                  worker was running goes back to the queue (ai.yaml host_worker.requeue_interrupted_max)
#   11 prune       releases the deploy lock and removes the build context first; then docker builder prune down to
#                  schedule.yaml deploy.build_cache_keep_gb, docker image prune (dangling only); never volumes, never images
#                  in use; a failure here only warns
#   12 doctor      waits (bounded) until the ai-worker service's current PID holds the worker lock and wrote a heartbeat
#                  and its shipped config report after this step started, then pnpm run doctor
#
#   --dry-run          print the steps and the commands, change nothing (read-only probes still run, and a problem
#                      that would stop a real run, a deploy lock held by another run included, is shown as a warning)
#   --skip-pull        do not touch git (deploy the checkout as it is; e.g. a rollback to an older commit)
#   --branch NAME      branch to deploy (default main); --remote NAME (default origin)
#   --ref REF          deploy a release tag (recommended for users, e.g. --ref v2.0.0) or another branch instead of main: the
#                      checkout is switched to it (a tag leaves git in detached HEAD; `git checkout main` returns). Running
#                      again with an older tag is the rollback of the code (the database comes from the pre-deploy backup)
#   --verify           with --ref <tag>: run `git verify-tag` first and stop when the signature is missing or invalid
#                      (uses the maintainer's public key in docs/signing-key.pub; deploy does not verify tags by default)
#   --no-backup        skip the pre-deploy backup
#   --no-prune         skip the Docker clean-up of step 11
#   --no-ai-worker     skip steps 7 and 10 and the step 12 worker wait; the lock is still taken
#   --no-drain         do not wait for a running cycle before step 8 (it is cut off; the runner's catch-up runs it again)
#   --drain-timeout S  wait at most S seconds for it (default: schedule.yaml deploy.drain_timeout_seconds)
#   --wait-timeout S   how long step 8 waits for the services to turn healthy (default 300)
#   --settle S         the longest step 12 waits for that, counted from its start (after the prune); 0 = no wait
#                      (default: schedule.yaml deploy.ai_worker_swap_timeout_seconds, 120)
#
# Exit code (decided once, at the end, by scripts/ops/lib/deploy-result.sh): 0 = deployed, the doctor found nothing or
# only warnings; 1 = a step failed (the message says which, and what state the services and the ai-worker are in), another
# deploy holds the lock, or the doctor itself could not run; 2 = deployed, but the doctor reports problems that need your
# attention, user config writes are pending, or the ai-worker service could not be confirmed working in step 12.
# Never runs `docker compose down -v`.
# Interrupting (Ctrl-C, closing the terminal, kill): the step that is running finishes first (it runs in its own process
# group, which the terminal's signals do not reach), no further step starts, the lock is released, and the exit code is
# 130 (INT), 143 (TERM) or 129 (HUP). To stop the running step at once, use the `kill -TERM -<group>` the script prints.
# Env: JOB_RADAR_DEPLOY_VOLUME=<mount point, e.g. /Volumes/Data>  refuse to deploy when the path contains '<mount point> 1' or
#      that directory exists (an external volume that was not unmounted cleanly and got mounted twice). Unset: no volume check.
#      JOB_RADAR_DEPLOY_EXPECT_SHA=<commit>  stop unless the commit to deploy is exactly this one (set by a calling script).
# Not covered (only you can do them): Docker login item, power settings, claude / codex login, Telegram (docs/deploy.md).
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ROOT="$APP"
OPS="scripts/ops"
TOTAL=12

# shellcheck source=lib/proc.sh
source "$APP/$OPS/lib/proc.sh"
# shellcheck source=lib/releases.sh
source "$APP/$OPS/lib/releases.sh"
# shellcheck source=lib/deploy-result.sh
source "$APP/$OPS/lib/deploy-result.sh"
# shellcheck source=lib/ai-worker.sh
source "$APP/$OPS/lib/ai-worker.sh"

DRY_RUN=0
SKIP_PULL=0
BRANCH="main"
REF=""
VERIFY=0
REMOTE="origin"
NO_BACKUP=0
NO_PRUNE=0
NO_AI_WORKER=0
NO_DRAIN=0
DRAIN_TIMEOUT=""
WAIT_TIMEOUT=300
SETTLE=""

# The header comment above (line 2 up to the first line that is not a comment); tests/ops/script-help.test.ts checks it names every option.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }
die() { echo "deploy: $*" >&2; exit 1; }
need_value() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }
need_number() { [[ "$2" =~ ^[0-9]+$ ]] || die "$1 needs a whole number, got '$2'"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-pull) SKIP_PULL=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    --no-prune) NO_PRUNE=1 ;;
    --no-ai-worker) NO_AI_WORKER=1 ;;
    --no-drain) NO_DRAIN=1 ;;
    --drain-timeout) need_value "$@"; need_number "$@"; DRAIN_TIMEOUT="$2"; shift ;;
    --branch) need_value "$@"; BRANCH="$2"; shift ;;
    --verify) VERIFY=1 ;;
    --ref) need_value "$@"; [[ "$2" =~ ^[A-Za-z0-9._/-]+$ && "$2" != -* ]] || die "--ref needs a tag or branch name, got '$2'"; REF="$2"; shift ;;
    --remote) need_value "$@"; REMOTE="$2"; shift ;;
    --wait-timeout) need_value "$@"; need_number "$@"; WAIT_TIMEOUT="$2"; shift ;;
    --settle) need_value "$@"; need_number "$@"; SETTLE="$((10#$2))"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

# Every command below runs in the checkout (no subshells: proc_run must run in this shell).
cd "$APP"

# Two config layers, the same directories compose.yaml mounts. A file in the user directory wins.
USER_CONFIG="$APP/data/config"
DEFAULTS_CONFIG="$APP/config"
config_file() { # config_file <name.yaml>: the file a config is read from (user directory first, then the shipped default)
  if [[ -f "$USER_CONFIG/$1" ]]; then echo "$USER_CONFIG/$1"; else echo "$DEFAULTS_CONFIG/$1"; fi
}

# schedule_value <block> <key>: a plain scalar under a top-level block of schedule.yaml (quotes stripped), empty when
# missing. Like backup.sh reads the time zone; `pnpm config:check` (step 4) validates the file against its schema.
schedule_value() {
  awk -v block="$1:" -v key="$2:" '
    $0 ~ "^" block { inside = 1; next }
    inside && /^[^ #]/ { inside = 0 }
    inside && $1 == key { value = $2; gsub(/["'"'"']/, "", value); print value; exit }
  ' "$(config_file schedule.yaml)" 2>/dev/null || true
}

# env_value KEY: the value of KEY in .env (first match, quotes stripped), empty when missing. Names only, never printed.
env_value() {
  [[ -f "$APP/.env" ]] || return 0
  grep -E "^[[:space:]]*$1=" "$APP/.env" | head -n1 | sed -E "s/^[[:space:]]*$1=//; s/^['\"]//; s/['\"][[:space:]]*\$//" || true
}

# The compose project: COMPOSE_PROJECT_NAME (environment, then .env: what docker compose itself uses for a second
# instance, docs/multiple-instances.md), else doctor.compose_project, else job-radar.
PROJECT="${COMPOSE_PROJECT_NAME:-}"
[[ -n "$PROJECT" ]] || PROJECT="$(env_value COMPOSE_PROJECT_NAME)"
[[ -n "$PROJECT" ]] || PROJECT="$(schedule_value doctor compose_project)"
PROJECT="${PROJECT:-job-radar}"

STEP=0
STEP_NAME=""
PROBLEMS=0
TARGET=""        # the commit this deploy builds and runs (fixed after the pull step)
ctx=""           # the build context directory, data/build/<TARGET>-<pid>
CLEANED=""       # on_exit ran
RELEASE_DONE=0   # the explicit release before the prune step ran (whatever it returned)
CONFIG_WRITES_PENDING=0   # 1 when user config writes were skipped, failed or are still due (set by a config write step)
WORKER_WAIT_RC=0  # 1 when step 12 could not confirm the ai-worker service (the exit code policy: lib/deploy-result.sh)
WAIT_OUT=""     # PID file of the step 12 wait
DOCTOR_RC=0      # the doctor's exit code (127 and the like: it could not run)

# A path is only ever removed when it is a real directory named like a build context, directly under data/build/.
BUILD_DIR="$APP/data/build"
is_build_context() { [[ "$1" == "$BUILD_DIR"/* && "${1##*/}" =~ ^[0-9a-f]{40,64}-[0-9]+$ && -d "$1" && ! -L "$1" ]]; }
remove_build_context() { if [[ -n "$ctx" ]] && is_build_context "$ctx"; then rm -rf -- "$ctx"; fi; }

# The only exit handler (proc_traps below): waits for the running process group, releases the lock (only when this run
# took it and nothing it or a child started may still run), removes the build context only after such a release, and
# maps the exit code (a signal's code wins; anything outside 0 / 1 / 2 becomes 1).
on_exit() {
  local rc=$? mine lrc
  set +e
  [[ -n "$WAIT_OUT" ]] && rm -f "$WAIT_OUT"
  [[ -n "$CLEANED" ]] && return; CLEANED=1
  [[ -z "$PROC_PGID" ]] || proc_group_wait "$PROC_PGID"
  if [[ "$RELEASE_DONE" != 1 ]]; then
    mine="$RELEASES_LOCK_MINE"; lrc=0; releases_lock_release "$APP" || lrc=$?
    (( lrc == 3 )) && rc=1
    if [[ "$mine" == 1 && "$lrc" == 0 ]]; then remove_build_context; fi
  fi
  exit "$(proc_exit_rc "$rc")"
}
proc_traps on_exit

step() {
  proc_check_stop   # a signal between two steps: the next one does not start
  STEP=$((STEP + 1))
  STEP_NAME="$1"
  echo
  echo "[$STEP/$TOTAL] $1"
}

say() { echo "  $*"; }

# A step failed: say which, why, and what to do; the steps already done are not undone.
fail_step() {
  echo >&2
  echo "deploy: step $STEP/$TOTAL \"${STEP_NAME}\" failed: $1" >&2
  [[ -z "${2:-}" ]] || echo "  What to do: $2" >&2
  echo "  Steps already done are not rolled back. After fixing the cause, run scripts/ops/deploy.sh again (it is safe to repeat)." >&2
  exit 1
}

# A condition that must hold. A real run stops here; a dry run only warns, so the whole plan still prints.
require() { # require <message> <hint>
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "  warning: a real run would stop here: $1"
    PROBLEMS=$((PROBLEMS + 1))
  else
    fail_step "$1" "${2:-}"
  fi
}

# Run a state-changing command in its own process group (proc_run), wait for it and everything it started, and stop
# when a signal came meanwhile (with that signal's exit code) or when it failed.
proc_step() { # proc_step <failure message> <hint> <command...>
  local why="$1" hint="$2" rc
  shift 2
  proc_check_stop; rc=0; proc_run "$@" || rc=$?; proc_check_stop
  (( rc == 0 )) || fail_step "$why" "$hint"
}

# Run a command in $APP. A dry run prints it only.
run() { # run <hint> <command...>
  local hint="$1"; shift
  echo "  \$ $*"
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  proc_step "command failed: $*" "$hint" "$@"
}

# The checkout must still be at the target commit with no tracked file changed (before every step that uses it). A git
# that fails (a damaged index, for instance) prints nothing on stdout: that is a failure, never "clean".
assert_target() {
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  local head status
  if ! head="$(git -C "$APP" rev-parse HEAD)" || ! status="$(git -C "$APP" status --porcelain --untracked-files=no)"; then
    fail_step "cannot check the checkout (git failed, see above): treated as checkout moved during deploy" "Fix the git error above (git status must work in $APP), then run this script again"
  fi
  [[ "$head" == "$TARGET" && -z "$status" ]] \
    || fail_step "checkout moved during deploy (HEAD is no longer $TARGET, or tracked files changed)" "Something changed the checkout while the deploy ran (another git command or editor?). Let it finish, then run this script again"
}

# Housekeeping that must not stop a deploy: print it, run it (not in a dry run), show its last line (the space it freed),
# and only warn when it fails.
housekeep() { # housekeep <command...>
  echo "  \$ $*"
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  local out
  if out="$("$@" 2>&1)"; then
    [[ -z "$out" ]] || say "$(printf '%s\n' "$out" | tail -n 1)"
  else
    say "warning: clean-up failed (the deploy continues): $(printf '%s\n' "$out" | tail -n 1)"
    PRUNE_WARNINGS=$((PRUNE_WARNINGS + 1))
  fi
}
PRUNE_WARNINGS=0

compose() { docker compose -p "$PROJECT" "$@"; }

# Build contexts under data/build/ whose deploy is gone (killed, or left for this run by a deploy under an inherited
# lock). Only called while holding the lock, after this run's in-flight record exists.
remove_stale_build_contexts() {
  local dir name pid
  [[ -d "$BUILD_DIR" && ! -L "$BUILD_DIR" ]] || return 0
  for dir in "$BUILD_DIR"/*; do
    is_build_context "$dir" || continue
    name="${dir##*/}"; pid="${name##*-}"
    if releases_pid_alive "$pid"; then
      say "data/build/$name: its deploy (pid $pid) is still running, left alone"
      continue
    fi
    rm -rf -- "$dir"
    say "removed data/build/$name (the build context of an earlier deploy that did not finish)"
  done
}

# ---------------------------------------------------------------------------------------------------------
echo "Job Radar deploy  checkout: $ROOT  project: $PROJECT$([[ "$DRY_RUN" -eq 1 ]] && echo '  [dry-run: prints only, changes nothing]')"

step "preflight: terminal, deploy lock, tools, Docker, clean checkout, external volume"
# With tostop set, a process group that is not in the foreground stops as soon as it writes to the terminal, and every step
# runs in its own group: the deploy would wait forever.
if proc_tostop_set; then
  fail_step "the terminal has tostop set: the steps run in the background and would stop at their first output" "Run stty -tostop in this terminal, then retry"
fi
LOCK_DIR="$(releases_lock_dir "$APP")"
if [[ "$DRY_RUN" -eq 1 ]]; then
  if [[ -e "$LOCK_DIR" ]] && ! releases_lock_verify "$APP"; then
    releases_lock_report "$APP" | sed 's/^/  /'
    require "the deploy lock $LOCK_DIR is held" "Wait for the other deploy to finish; if none is running, clear the lock as shown above"
  fi
elif releases_lock_acquire "$APP"; then
  if [[ "$RELEASES_LOCK_MINE" == 1 ]]; then say "deploy lock taken: $LOCK_DIR"; else say "deploy lock held by the calling script: $LOCK_DIR"; fi
  releases_inflight_register "$APP" deploy.sh || fail_step "could not write the in-flight record under $LOCK_DIR" "Check write permission on data/releases/"
  remove_stale_build_contexts
  sweep_tmp "$APP" || say "warning: could not remove every leftover .tmp-* / .trash-* under data/releases/ai-worker (see above); the deploy continues"
elif [[ "$RELEASES_LOCK_VANISHED" == 1 ]]; then
  fail_step "the deploy lock $LOCK_DIR was released while this deploy was taking it; nothing was changed" "Run this script again"
elif [[ "$RELEASES_LOCK_PARTIAL" == 1 ]]; then
  # A half-made lock that could not be removed is still this run's: release it here (it is kept and reported).
  RELEASE_DONE=1
  releases_lock_release "$APP" || true
  fail_step "could not initialise the deploy lock $LOCK_DIR, and could not remove the half-made lock (see above)" "Fix the cause (free disk space, write permission on data/releases/), clear the leftover lock with the rm -rf command shown above, then retry"
elif [[ "$RELEASES_LOCK_INIT_FAILED" == 1 ]]; then
  # Not another deploy: this run could not set the lock up (the reason is above); nothing of it is left.
  fail_step "could not initialise the deploy lock $LOCK_DIR (see the message above)" "Check free disk space and write permission on data/releases/, then retry"
else
  [[ ! -e "$LOCK_DIR" ]] || releases_lock_report "$APP" >&2
  fail_step "another deploy holds the lock $LOCK_DIR (or the lock token passed in does not match it); nothing was changed" "Wait for the other deploy to finish; if none is running, check and clear the lock as shown above"
fi
for tool in git docker node pnpm; do
  if command -v "$tool" >/dev/null 2>&1; then say "$tool: $(command -v "$tool")"; else require "$tool not found" "Install it (for docker: Docker Desktop) and make sure it is on PATH"; fi
done
# Optional guard against a doubly mounted external volume (macOS mounts the second copy as "<name> 1"). Off unless asked for.
VOLUME="${JOB_RADAR_DEPLOY_VOLUME:-}"
if [[ -n "$VOLUME" ]]; then
  case "$ROOT" in
    *"$VOLUME 1"*) require "the path contains '$(basename "$VOLUME") 1': the external volume was not unmounted cleanly last time" "Fix the volume first (diskutil / remount); do not deploy from this path" ;;
  esac
  if [[ "$ROOT" == "$(dirname "$VOLUME")"/* ]]; then
    [[ ! -e "$VOLUME 1" ]] || require "$VOLUME 1 exists: the external volume is mounted twice" "Fix the volume first, then deploy"
  fi
fi
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then say "Docker is running"; else require "Docker is not running" "open -a Docker, wait until the whale icon in the menu bar settles, then retry"; fi
fi
[[ -f "$APP/package.json" ]] || require "$APP/package.json does not exist" "Run this from a Job Radar checkout"
# Every mode (--skip-pull too): the images are built from the commit, so a local change would silently not be deployed.
# A failing git status (a damaged index) prints nothing on stdout: that must not read as a clean checkout.
if ! CHECKOUT_STATUS="$(git -C "$ROOT" status --porcelain --untracked-files=no)"; then
  require "cannot read the state of the checkout (git status failed, see above)" "Fix the git error above (git status must work in $ROOT), then retry"
elif [[ -n "$CHECKOUT_STATUS" ]]; then
  require "there are uncommitted changes" "Commit or git stash them first; deploy only accepts a clean checkout (the images are built from the commit, local changes would not reach them)"
fi

step "pull: update the code"
if [[ "$SKIP_PULL" -eq 1 ]]; then
  say "--skip-pull: git is left alone, deploying the checkout as it is ($(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"
else
  current="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [[ -z "$REF" && "$current" != "$BRANCH" ]]; then
    require "the current branch is ${current}, not $BRANCH" "Run from the main checkout (not a worktree or feature branch), use --ref <tag> to deploy a release, run \`git switch main\` if HEAD is detached, or --skip-pull to deploy the current code"
  fi
  before="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [[ -n "$REF" ]]; then
    echo "  \$ git fetch --tags --force $REMOTE '+refs/heads/*:refs/remotes/$REMOTE/*'"
    echo "  \$ git checkout --detach <tag $REF, else branch $REMOTE/$REF>"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      proc_step "git fetch failed" "Check the network and the address of $REMOTE (git remote -v)" git -C "$ROOT" fetch --tags --force "$REMOTE" "+refs/heads/*:refs/remotes/$REMOTE/*"
      ref_target=""
      if git -C "$ROOT" rev-parse -q --verify "refs/tags/$REF^{commit}" >/dev/null; then ref_target="refs/tags/$REF"
      elif git -C "$ROOT" rev-parse -q --verify "refs/remotes/$REMOTE/$REF^{commit}" >/dev/null; then ref_target="refs/remotes/$REMOTE/$REF"
      else fail_step "$REF is neither a tag nor a branch of $REMOTE" "List the releases with: git tag --list 'v*'"; fi
      if [[ "$VERIFY" -eq 1 ]]; then
        [[ "$ref_target" == refs/tags/* ]] || fail_step "--verify needs a tag, but $REF is a branch" "Use --ref <tag>, or drop --verify"
        # releases are signed with an SSH key; the maintainer's public key ships as docs/signing-key.pub (allowed_signers format).
        # A key list you configured yourself (git config gpg.ssh.allowedSignersFile) wins over it.
        signers=()
        if [[ -z "$(git -C "$ROOT" config --get gpg.ssh.allowedSignersFile || true)" && -f "$ROOT/docs/signing-key.pub" ]]; then
          signers=(-c "gpg.ssh.allowedSignersFile=$ROOT/docs/signing-key.pub")
        fi
        git -C "$ROOT" -c gpg.format=ssh ${signers[@]+"${signers[@]}"} verify-tag "$REF" || fail_step "the signature of tag $REF is missing or invalid" "Check docs/signing-key.pub against the fingerprint in SECURITY.md, or deploy without --verify if you accept an unsigned tag"
        say "signature of $REF verified"
      fi
      # The resolved commit (never the raw name) must run the worker from a release directory: an older install script
      # would not understand --release (the ai-worker step), and going back before release directories is a manual
      # procedure. Checked before the checkout moves.
      commit="$(git -C "$ROOT" rev-parse "$ref_target^{commit}")" || fail_step "cannot resolve $REF to a commit" "Read the git error above"
      if ! git -C "$ROOT" show "$commit:scripts/ops/install-ai-worker.sh" 2>/dev/null | grep -qx '# capability: ai-worker-release-dir'; then
        fail_step "$REF ($commit) is a version from before the ai-worker ran from release directories; deploy.sh cannot switch to it (the checkout was not changed)" "Follow docs/upgrade.md#downgrade-pre-release-dir (uninstall the worker first, then check out and deploy the old version by hand)"
      fi
      proc_step "could not check out $REF" "Resolve the git error above, then run this script again" git -C "$ROOT" checkout --detach "$ref_target"
      say "$before -> $(git -C "$ROOT" rev-parse --short HEAD) ($REF)"
    fi
  else
    echo "  \$ git fetch $REMOTE $BRANCH"
    echo "  \$ git merge --ff-only $REMOTE/$BRANCH"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      proc_step "git fetch failed" "Check the network and the address of $REMOTE (git remote -v)" git -C "$ROOT" fetch "$REMOTE" "$BRANCH"
      proc_step "$BRANCH and $REMOTE/$BRANCH have diverged, cannot fast-forward" "The local $BRANCH has commits that are not on the remote: find out why before deploying, do not force-push" git -C "$ROOT" merge --ff-only "$REMOTE/$BRANCH"
      say "$before -> $(git -C "$ROOT" rev-parse --short HEAD)"
    fi
  fi
fi
# From here on "the commit to deploy" is TARGET, never whatever HEAD is at the moment.
TARGET="$(git -C "$APP" rev-parse HEAD)"
say "target commit: $TARGET$([[ "$DRY_RUN" -eq 1 && "$SKIP_PULL" -eq 0 ]] && echo ' (now; a real run uses the commit it pulls)')"
if [[ -n "${JOB_RADAR_DEPLOY_EXPECT_SHA:-}" && "$JOB_RADAR_DEPLOY_EXPECT_SHA" != "$TARGET" ]]; then
  require "checkout is not at the approved commit (expected $JOB_RADAR_DEPLOY_EXPECT_SHA)" "The calling script approved another commit; nothing was changed"
fi

step "install: dependencies"
assert_target
run "Read the pnpm error; for network problems just retry" pnpm install --frozen-lockfile

step "config: configuration, .env, data directories"
assert_target
run "Check write permission on the product directory (is the external volume writable?)" mkdir -p data/config data/profile data/backups data/exports
if [[ -n "$(ls -A "$USER_CONFIG" 2>/dev/null)" ]]; then
  say "user config directory data/config already has files: only missing ones are added, existing ones are left alone"
else
  say "user config directory data/config is empty (first layered deploy): the current config/ is copied over in full; from then on the web UI writes only to data/config"
fi
run "Read the pnpm config:init error; it only copies missing files and never overwrites" pnpm config:init
run "A failed migration writes nothing: fix the file in data/config named in the error (a version newer than the code means the code was rolled back; restore from data/config/.backup/); read the rollback notes in CHANGELOG.md first" pnpm config:migrate --write
run "Fix data/config/*.yaml as the error says (pnpm config:check names the file, the field and which layer it was read from)" pnpm config:check
if [[ -f "$APP/.env" ]]; then say ".env exists"; else say "warning: .env does not exist: compose uses defaults, but Telegram and channel keys need it (cp .env.example .env and fill it in; see docs/deploy.md)"; fi
run "The docker compose config has a syntax error: docker compose config shows where" docker compose -p "$PROJECT" config -q

step "backup: back up the database before upgrading"
if [[ "$NO_BACKUP" -eq 1 ]]; then
  say "--no-backup: skipped"
elif compose ps --status running --services 2>/dev/null | grep -qx db; then
  say "db is already running: taking a backup first, to roll back with"
  run "Do not upgrade when the backup fails: read docker compose logs db first; use --no-backup only if you really want to skip it" "$OPS/backup.sh" --label pre-deploy
else
  say "db is not running yet (first deploy): nothing to back up, skipped"
fi

step "build: build the images from the target commit"
assert_target
ctx="$BUILD_DIR/$TARGET-$$"
say "build context: data/build/$TARGET-$$ (git archive of the target commit; removed when the deploy ends)"
run "Check write permission on data/ (is the external volume writable?)" mkdir -p "$ctx"
echo "  \$ git archive $TARGET | tar -x -C data/build/$TARGET-$$"
if [[ "$DRY_RUN" -eq 0 ]]; then
  # shellcheck disable=SC2016  # the single quotes are the inner script; the values come in as positional parameters
  proc_step "could not unpack the target commit into the build context" "Read the git / tar error above (disk full? docker system df and df -h show usage)" \
    bash -o pipefail -c 'git -C "$1" archive "$2" | tar -x -C "$3"' _ "$APP" "$TARGET" "$ctx"
fi
export JOB_RADAR_BUILD_CONTEXT="$ctx"   # every compose call from here on builds from it
run "Read the build log above; if the disk is full, clean up first (docker system df shows usage, docker builder prune clears the build cache)" docker compose -p "$PROJECT" build

step "release: the ai-worker's release directory for the target commit"
if [[ "$NO_AI_WORKER" -eq 1 ]]; then
  say "--no-ai-worker: skipped"
else
  say "data/releases/ai-worker/$TARGET (read-only; reused when it is already there). The running ai-worker is not touched."
  echo "  \$ $OPS/prepare-release.sh $TARGET --root $APP"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    assert_target
    proc_step "could not prepare the release directory of $TARGET (see the prepare-release lines above)" \
      "Nothing is restarted yet: the services and the ai-worker still run the previous version. Fix the cause (pnpm version: corepack enable; disk space; network for pnpm), then run this script again" \
      "$OPS/prepare-release.sh" "$TARGET" --root "$APP"
  fi
fi

step "up: start and wait until healthy (at most ${WAIT_TIMEOUT} s)"
# Recreating the runner cuts off a running cycle, so wait (bounded) for it first. Control requests are not waited for:
# one a restart interrupts goes back to the queue. A cycle still running after the timeout only warns: the runner's catch-up
# runs that slot again at start-up.
if [[ "$NO_DRAIN" -eq 1 ]]; then
  say "--no-drain: not waiting for a running cycle (an interrupted cycle is re-run by the runner's catch-up at start-up)"
else
  drain=(pnpm ops:drain)
  [[ -z "$DRAIN_TIMEOUT" ]] || drain+=(--timeout "$DRAIN_TIMEOUT")
  say "waiting for a running cycle to finish first (at most ${DRAIN_TIMEOUT:-<schedule.yaml deploy.drain_timeout_seconds>} s); running AI requests are not waited for, they are queued again after the restart"
  echo "  \$ ${drain[*]}"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    assert_target
    proc_check_stop; drain_code=0; proc_run "${drain[@]}" || drain_code=$?; proc_check_stop
    case "$drain_code" in
      0) ;;
      1) say "warning: a cycle is still running after the wait; the deploy continues: the restart cuts it off and the runner's catch-up re-runs that slot at start-up" ;;
      3) say "warning: could not check for a running cycle (config or database error, or a query that hung; see the ops:drain lines above); the deploy continues: a cycle that is running is cut off and the runner's catch-up re-runs that slot at start-up" ;;
      *) say "warning: could not check for a running cycle (pnpm ops:drain exited with ${drain_code}); the deploy continues: an interrupted cycle is re-run by the runner's catch-up at start-up" ;;
    esac
  fi
fi
echo "  \$ docker compose -p $PROJECT up -d --wait --wait-timeout $WAIT_TIMEOUT"
if [[ "$DRY_RUN" -eq 0 ]]; then
  assert_target
  proc_check_stop; up_code=0; proc_run docker compose -p "$PROJECT" up -d --wait --wait-timeout "$WAIT_TIMEOUT" || up_code=$?; proc_check_stop
  if (( up_code != 0 )); then
    compose ps >&2 || true
    fail_step "not all services became healthy within ${WAIT_TIMEOUT} s" "docker compose -p $PROJECT logs --tail 100 <db|web|runner|jobspy> shows which one and why; after fixing it, run this script again"
  fi
  compose ps
fi

step "migrate: database migrations"
assert_target
run "Migration failed: the database is not left half-changed (each migration runs in a transaction); read the error and, if needed, restore the pre-deploy backup (docs/backup-restore.md)" pnpm migrate:run

step "ai-worker: host AI process (launchd / systemd) from the release directory"
if [[ "$NO_AI_WORKER" -eq 1 ]]; then
  say "--no-ai-worker: skipped"
else
  say "switching the ai-worker to data/releases/ai-worker/$TARGET: an AI request it is running (for example run_ai) goes back to the queue and runs again after the switch; nothing is lost"
  echo "  \$ $OPS/install-ai-worker.sh --release $APP/data/releases/ai-worker/$TARGET --root $APP"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    assert_target
    # cooperative: a signal to this script reaches the install as one TERM, and it rolls the switch back before it ends
    proc_check_stop; install_rc=0; proc_run --cooperative "$OPS/install-ai-worker.sh" --release "$APP/data/releases/ai-worker/$TARGET" --root "$APP" || install_rc=$?; proc_check_stop
    if (( install_rc != 0 )); then
      fail_step "the ai-worker switch failed (install-ai-worker.sh exited $install_rc). The web, runner and database already run the new version (migrations applied)" \
        "The first line of the install output says where the worker is: 'not changed:' the old worker still runs untouched; 'rolled back:' the old worker runs again (checked); 'ROLLBACK FAILED:' follow the commands printed above and keep data/run/ai-worker-swap-backup/. Fix the cause (logs: data/logs/ai-worker.err.log), then run this script again"
    fi
  fi
fi

step "prune: release the deploy lock, clean the Docker build cache and dangling images"
# Everything that changes the deployment is done: release the lock this run took (the clean-up below runs outside it).
# Under a lock passed in by a calling script nothing is released here: that script releases it after this one ends.
if [[ "$DRY_RUN" -eq 1 ]]; then
  say "the deploy lock is released here, and the build context removed"
elif [[ "$RELEASES_LOCK_MINE" == 1 ]]; then
  RELEASE_DONE=1
  release_rc=0; releases_lock_release "$APP" || release_rc=$?
  if (( release_rc == 3 )); then
    kept="the build context data/build/$TARGET-$$ is kept"
    case "$RELEASES_LOCK_KEPT" in
      owner-changed) fail_step "the deploy lock now belongs to another run, so it was not released (see above); $kept" "Everything is deployed. Something replaced the lock while this deploy held it: find out which run holds it now before deploying again (do not clear a lock another deploy holds)" ;;
      gone) fail_step "the deploy lock disappeared while this deploy held it (someone removed $LOCK_DIR); $kept" "Everything is deployed. Find out what removed the lock before deploying again" ;;
      owner-unreadable | partial) fail_step "the owner file of the deploy lock is missing or damaged; lock left in place (see above), and $kept" "Everything is deployed. Check and clear the lock as shown above before the next deploy" ;;
      unexpected) fail_step "the deploy lock holds unexpected entries; lock left in place (see above), and $kept" "Everything is deployed. Check and clear the lock as shown above before the next deploy" ;;
      rmdir) fail_step "the deploy lock could not be removed; lock left in place (see above), and $kept" "Everything is deployed. Check and clear the lock as shown above before the next deploy" ;;
      *) fail_step "descendant exit not confirmed; lock left in place (see above), and $kept" "Everything is deployed. Check and clear the lock as shown above before the next deploy" ;;
    esac
  fi
  remove_build_context
  say "deploy lock released, build context removed"
else
  say "the deploy lock belongs to the calling script: it is released after this script ends (the build context is removed by the next deploy)"
fi
if [[ "$NO_PRUNE" -eq 1 ]]; then
  say "--no-prune: skipped"
else
  # Defaults mirror the shipped schedule.yaml (deploy block) for an older file without it. Read from data/config first.
  prune_cache="$(schedule_value deploy prune_build_cache)"; prune_cache="${prune_cache:-true}"
  keep_gb="$(schedule_value deploy build_cache_keep_gb)"; keep_gb="${keep_gb:-5}"
  prune_images="$(schedule_value deploy prune_dangling_images)"; prune_images="${prune_images:-true}"
  say "only the build cache and dangling images are cleaned; data volumes and images in use are never touched (settings: deploy block of schedule.yaml; --no-prune skips)"
  if [[ "$prune_cache" != "true" ]]; then
    say "deploy.prune_build_cache is not true: the build cache is not cleaned"
  elif [[ ! "$keep_gb" =~ ^[0-9]+$ ]]; then
    say "warning: deploy.build_cache_keep_gb is not a whole number (${keep_gb}): build cache clean-up skipped"
    PRUNE_WARNINGS=$((PRUNE_WARNINGS + 1))
  elif [[ "$keep_gb" -eq 0 ]]; then
    housekeep docker builder prune -f
  else
    housekeep docker builder prune -f --max-used-space "${keep_gb}gb"
  fi
  if [[ "$prune_images" == "true" ]]; then
    housekeep docker image prune -f
  else
    say "deploy.prune_dangling_images is not true: dangling images are not removed"
  fi
  [[ "$PRUNE_WARNINGS" -eq 0 ]] || say "The clean-up did not fully complete; the deploy continues. Check usage later with docker system df"
fi

step "doctor: overall check"
if [[ "$NO_AI_WORKER" -eq 0 ]]; then
  ai_worker_deploy_settings "$APP"   # after config:check; warns and falls back on a bad value
  [[ -n "$SETTLE" ]] || SETTLE="$AI_WORKER_SWAP_TIMEOUT"
fi
if [[ "$NO_AI_WORKER" -eq 1 ]]; then say "--no-ai-worker: no wait for the ai-worker"
elif [[ "$SETTLE" -eq 0 ]]; then say "--settle 0: no wait for the ai-worker"
else echo "  \$ (wait at most $SETTLE s until the ai-worker service's current PID holds the lock and wrote a heartbeat and its config report)"; fi
echo "  \$ pnpm run doctor"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo
  if [[ "$PROBLEMS" -gt 0 ]]; then
    echo "dry-run finished: nothing was changed. $PROBLEMS condition(s) are not met right now (see the warnings above); a real run would stop there."
  else
    echo "dry-run finished: nothing was changed, all conditions are met. Remove --dry-run to deploy for real."
  fi
  exit 0
fi
if [[ "$NO_AI_WORKER" -eq 0 && "$SETTLE" -gt 0 ]]; then
  # Keep the wait in this shell so its interrupt checks see STOPPING; only the PID goes through the file.
  WAIT_OUT="$(mktemp "${TMPDIR:-/tmp}/deploy-wait.XXXXXX")" || WAIT_OUT=""
  wait_rc=0
  if [[ -n "$WAIT_OUT" ]]; then AI_WORKER_STOP_CHECK=1 ai_worker_wait_fresh "$APP" "$SETTLE" > "$WAIT_OUT" || wait_rc=$?; else wait_rc=1; fi
  fresh_pid="$(head -n 1 "$WAIT_OUT" 2>/dev/null)" || fresh_pid=""
  rm -f "$WAIT_OUT"; WAIT_OUT=""
  proc_check_stop
  case "$wait_rc" in
    0) say "ai-worker (pid $fresh_pid) confirmed: lock, heartbeat and config report since this step began" ;;
    3) say "no ai-worker service is installed here: nothing to wait for" ;;
    *) echo "deploy: ⚠ could not confirm within $SETTLE s that the ai-worker service is working (lock, heartbeat and config report of its current PID); see the doctor below, data/logs/ai-worker.err.log, and \"could not report the shipped config\" in data/logs/ai-worker.out.log" >&2
       WORKER_WAIT_RC=1 ;;
  esac
fi
proc_check_stop
# The doctor's verdict is only recorded here; the exit code is decided once, below (deploy_final_rc).
DOCTOR_RC=0; proc_run pnpm run doctor || DOCTOR_RC=$?
proc_check_stop
echo
if [[ "$WORKER_WAIT_RC" == 1 && "$DOCTOR_RC" =~ ^[01]$ ]]; then
  echo "Deploy complete, but the ai-worker service could not be confirmed working (see the warning above); the doctor found $([[ $DOCTOR_RC == 0 ]] && echo 'nothing else' || echo 'warnings too')." >&2
else
  case "$DOCTOR_RC" in
    0) echo "Deploy complete, doctor passed everything." ;;
    1) echo "Deploy complete. The doctor reported warnings (see above); they do not stop it from running, handle them when you have time." ;;
    2) echo "Deploy complete, but the doctor reported problems (see the hints above)." >&2 ;;
    *) echo "deploy: everything is deployed, but the doctor itself could not run (exit code ${DOCTOR_RC}). Run pnpm run doctor on its own to see the error." >&2 ;;
  esac
fi
if [[ "$CONFIG_WRITES_PENDING" == 1 ]]; then
  echo "deploy: user config writes are pending (see above)$([[ "$DOCTOR_RC" =~ ^[012]$ ]] || echo '; the doctor did not run either')." >&2
fi
exit "$(deploy_final_rc "$CONFIG_WRITES_PENDING" "$DOCTOR_RC" "$WORKER_WAIT_RC")"
