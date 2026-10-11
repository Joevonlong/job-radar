#!/usr/bin/env bash
# Deploy / upgrade Job Radar on this machine. Safe to run again: every step is idempotent.
#
#   scripts/ops/deploy.sh [--dry-run] [--skip-pull] [--branch main | --ref v2.0.0 [--verify]] [--remote origin]
#                     [--no-backup] [--no-prune] [--no-ai-worker] [--no-drain] [--drain-timeout S]
#                     [--wait-timeout 300] [--settle 20]
#
# Steps (each prints what it does; the first one that fails stops the script and says why):
#   1  preflight   git, docker, node, pnpm are installed and Docker is running; optional external-volume guard
#   2  pull        the checkout is on the branch, clean, and fast-forwards to <remote>/<branch>
#   3  install     pnpm install --frozen-lockfile
#   4  config      data/ folders exist; pnpm config:init (copies what the user config directory data/config lacks from the
#                  shipped defaults config/, never overwrites; the first layered run copies the whole live config),
#                  pnpm config:migrate --write (config_version upgrades, originals in data/config/.backup/),
#                  pnpm config:check; .env present; docker compose config
#   5  backup      scripts/ops/backup.sh --label pre-deploy (only when the db is already running)
#   6  build       docker compose -p job-radar build
#   7  up          pnpm ops:drain (wait, bounded by schedule.yaml deploy.drain_timeout_seconds, for a running cycle to finish:
#                  recreating the runner would cut it off), then docker compose -p job-radar up -d --wait (db / web / runner /
#                  jobspy must turn healthy)
#   8  prune       docker builder prune down to schedule.yaml deploy.build_cache_keep_gb, docker image prune (dangling
#                  only); never volumes, never images in use; a failure here only warns
#   9  migrate     pnpm migrate:run (the runner migrates at start-up too; this checks it and is a no-op then)
#   10 ai-worker   scripts/ops/install-ai-worker.sh (installs or restarts the service: a launchd agent on macOS, a systemd user unit on Linux; also migrates
#                  an agent still installed under the old label de.jobradar.ai-worker to io.jobradar.ai-worker); an AI
#                  request it was running goes back to the queue and runs again after the restart
#                  (ai.yaml host_worker.requeue_interrupted_max)
#   11 doctor      pnpm run doctor
#
#   --dry-run          print the steps and the commands, change nothing (read-only probes still run, and a problem
#                      that would stop a real run is shown as a warning)
#   --skip-pull        do not touch git (deploy the checkout as it is; e.g. a rollback to an older commit)
#   --branch NAME      branch to deploy (default main); --remote NAME (default origin)
#   --ref REF          deploy a release tag (recommended for users, e.g. --ref v2.0.0) or another branch instead of main: the
#                      checkout is switched to it (a tag leaves git in detached HEAD; `git checkout main` returns). Running
#                      again with an older tag is the rollback of the code (the database comes from the pre-deploy backup)
#   --verify           with --ref <tag>: run `git verify-tag` first and stop when the signature is missing or invalid
#                      (uses the maintainer's public key in docs/signing-key.pub; deploy does not verify tags by default)
#   --no-backup        skip the pre-deploy backup
#   --no-prune         skip the Docker clean-up of step 8
#   --no-ai-worker     do not install / restart the ai-worker
#   --no-drain         do not wait for a running cycle before step 7 (it is cut off; the runner's catch-up runs it again)
#   --drain-timeout S  wait at most S seconds for it (default: schedule.yaml deploy.drain_timeout_seconds)
#   --wait-timeout S   how long step 7 waits for the services to turn healthy (default 300)
#   --settle S         seconds between the ai-worker restart and the doctor run, so heartbeats arrive (default 20)
#
# Exit code: 0 = deployed, doctor found nothing or only warnings; 1 = a step failed (the message says which);
# 2 = deployed, but the doctor reports problems that need your attention. Never runs `docker compose down -v`.
# Env: JOB_RADAR_DEPLOY_VOLUME=<mount point, e.g. /Volumes/Data>  refuse to deploy when the path contains '<mount point> 1' or
#      that directory exists (an external volume that was not unmounted cleanly and got mounted twice). Unset: no volume check.
# Not covered (only you can do them): Docker login item, power settings, claude / codex login, Telegram (docs/deploy.md).
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
ROOT="$APP"
OPS="scripts/ops"
TOTAL=11

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
SETTLE=20

usage() { sed -n '2,51p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
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
    --settle) need_value "$@"; need_number "$@"; SETTLE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

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

step() {
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

# Run a command in $APP. A dry run prints it only.
run() { # run <hint> <command...>
  local hint="$1"; shift
  echo "  \$ $*"
  [[ "$DRY_RUN" -eq 1 ]] && return 0
  if ! (cd "$APP" && "$@"); then
    fail_step "command failed: $*" "$hint"
  fi
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

# ---------------------------------------------------------------------------------------------------------
echo "Job Radar deploy  checkout: $ROOT  project: $PROJECT$([[ "$DRY_RUN" -eq 1 ]] && echo '  [dry-run: prints only, changes nothing]')"

step "preflight: tools, Docker, external volume"
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

step "pull: update the code"
if [[ "$SKIP_PULL" -eq 1 ]]; then
  say "--skip-pull: git is left alone, deploying the checkout as it is ($(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?'))"
else
  current="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  if [[ -z "$REF" && "$current" != "$BRANCH" ]]; then
    require "the current branch is ${current}, not $BRANCH" "Run from the main checkout (not a worktree or feature branch), use --ref <tag> to deploy a release, run `git switch main` if HEAD is detached, or --skip-pull to deploy the current code"
  fi
  if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no 2>/dev/null)" ]]; then
    require "there are uncommitted changes" "Commit or git stash them first; deploy only accepts a clean checkout"
  fi
  before="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  if [[ -n "$REF" ]]; then
    echo "  \$ git fetch --tags --force $REMOTE '+refs/heads/*:refs/remotes/$REMOTE/*'"
    echo "  \$ git checkout --detach <tag $REF, else branch $REMOTE/$REF>"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      git -C "$ROOT" fetch --tags --force "$REMOTE" "+refs/heads/*:refs/remotes/$REMOTE/*" || fail_step "git fetch failed" "Check the network and the address of $REMOTE (git remote -v)"
      target=""
      if git -C "$ROOT" rev-parse -q --verify "refs/tags/$REF^{commit}" >/dev/null; then target="refs/tags/$REF"
      elif git -C "$ROOT" rev-parse -q --verify "refs/remotes/$REMOTE/$REF^{commit}" >/dev/null; then target="refs/remotes/$REMOTE/$REF"
      else fail_step "$REF is neither a tag nor a branch of $REMOTE" "List the releases with: git tag --list 'v*'"; fi
      if [[ "$VERIFY" -eq 1 ]]; then
        [[ "$target" == refs/tags/* ]] || fail_step "--verify needs a tag, but $REF is a branch" "Use --ref <tag>, or drop --verify"
        # releases are signed with an SSH key; the maintainer's public key ships as docs/signing-key.pub (allowed_signers format).
        # A key list you configured yourself (git config gpg.ssh.allowedSignersFile) wins over it.
        signers=()
        if [[ -z "$(git -C "$ROOT" config --get gpg.ssh.allowedSignersFile || true)" && -f "$ROOT/docs/signing-key.pub" ]]; then
          signers=(-c "gpg.ssh.allowedSignersFile=$ROOT/docs/signing-key.pub")
        fi
        git -C "$ROOT" -c gpg.format=ssh ${signers[@]+"${signers[@]}"} verify-tag "$REF" || fail_step "the signature of tag $REF is missing or invalid" "Check docs/signing-key.pub against the fingerprint in SECURITY.md, or deploy without --verify if you accept an unsigned tag"
        say "signature of $REF verified"
      fi
      git -C "$ROOT" checkout --detach "$target" || fail_step "could not check out $REF" "Resolve the git error above, then run this script again"
      say "$before -> $(git -C "$ROOT" rev-parse --short HEAD) ($REF)"
    fi
  else
    echo "  \$ git fetch $REMOTE $BRANCH"
    echo "  \$ git merge --ff-only $REMOTE/$BRANCH"
    if [[ "$DRY_RUN" -eq 0 ]]; then
      git -C "$ROOT" fetch "$REMOTE" "$BRANCH" || fail_step "git fetch failed" "Check the network and the address of $REMOTE (git remote -v)"
      git -C "$ROOT" merge --ff-only "$REMOTE/$BRANCH" || fail_step "$BRANCH and $REMOTE/$BRANCH have diverged, cannot fast-forward" "The local $BRANCH has commits that are not on the remote: find out why before deploying, do not force-push"
      say "$before -> $(git -C "$ROOT" rev-parse --short HEAD)"
    fi
  fi
fi

step "install: dependencies"
run "Read the pnpm error; for network problems just retry" pnpm install --frozen-lockfile

step "config: configuration, .env, data directories"
run "Check write permission on the product directory (is the external volume writable?)" mkdir -p data/config data/profile data/backups data/exports
if [[ -n "$(ls -A "$USER_CONFIG" 2>/dev/null)" ]]; then
  say "user config directory data/config already has files: only missing ones are added, existing ones are left alone"
else
  say "user config directory data/config is empty (first layered deploy): the current config/ is copied over in full; from then on the web UI writes only to data/config"
fi
run "Read the pnpm config:init error; it only copies missing files and never overwrites" pnpm config:init
run "A failed migration writes nothing: fix the file in data/config named in the error (a version newer than the code means the code was rolled back; restore from data/config/.backup/)" pnpm config:migrate --write
run "Fix data/config/*.yaml as the error says (pnpm config:check names the file, the field and which layer it was read from)" pnpm config:check
if [[ -f "$APP/.env" ]]; then say ".env exists"; else say "warning: .env does not exist: compose uses defaults, but Telegram and channel keys need it (cp .env.example .env and fill it in; see docs/deploy.md)"; fi
run "The docker compose config has a syntax error: docker compose config shows where" docker compose -p "$PROJECT" config -q

step "backup: back up the database before upgrading"
if [[ "$NO_BACKUP" -eq 1 ]]; then
  say "--no-backup: skipped"
elif (cd "$APP" && compose ps --status running --services 2>/dev/null | grep -qx db); then
  say "db is already running: taking a backup first, to roll back with"
  run "Do not upgrade when the backup fails: read docker compose logs db first; use --no-backup only if you really want to skip it" "$OPS/backup.sh" --label pre-deploy
else
  say "db is not running yet (first deploy): nothing to back up, skipped"
fi

step "build: build the images"
run "Read the build log above; if the disk is full, clean up first (docker system df shows usage, docker builder prune clears the build cache)" docker compose -p "$PROJECT" build

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
    drain_code=0
    (cd "$APP" && "${drain[@]}") || drain_code=$?
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
  if ! (cd "$APP" && compose up -d --wait --wait-timeout "$WAIT_TIMEOUT"); then
    (cd "$APP" && compose ps) >&2 || true
    fail_step "not all services became healthy within ${WAIT_TIMEOUT} s" "docker compose -p $PROJECT logs --tail 100 <db|web|runner|jobspy> shows which one and why; after fixing it, run this script again"
  fi
  (cd "$APP" && compose ps)
fi

step "prune: clean the Docker build cache and dangling images"
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

step "migrate: database migrations"
run "Migration failed: the database is not left half-changed (each migration runs in a transaction); read the error and, if needed, restore the pre-deploy backup (docs/backup-restore.md)" pnpm migrate:run

step "ai-worker: host AI process (launchd / systemd)"
if [[ "$NO_AI_WORKER" -eq 1 ]]; then
  say "--no-ai-worker: skipped"
else
  say "restarting the ai-worker: an AI request it is running (for example run_ai) goes back to the queue and runs again after the restart; nothing is lost"
  run "Read the output of scripts/ops/install-ai-worker.sh, data/logs/ai-worker.err.log and ~/Library/Logs/job-radar/ai-worker.launchd.log; claude / codex must be on PATH" "$OPS/install-ai-worker.sh"
fi

step "doctor: overall check"
echo "  \$ sleep $SETTLE   # let the runner / ai-worker heartbeats arrive"
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
sleep "$SETTLE"
set +e
(cd "$APP" && pnpm run doctor)
doctor_code=$?
set -e
echo
case "$doctor_code" in
  0) echo "Deploy complete, doctor passed everything." ;;
  1) echo "Deploy complete. The doctor reported warnings (see above); they do not stop it from running, handle them when you have time." ;;
  2) echo "Deploy complete, but the doctor reported problems (see the hints above)." >&2; exit 2 ;;
  *) STEP_NAME="doctor: overall check"; fail_step "the doctor itself could not run (exit code ${doctor_code})" "Run pnpm run doctor on its own to see the error" ;;
esac
