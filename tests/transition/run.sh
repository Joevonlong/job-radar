#!/usr/bin/env bash
# The ai-worker's move between release directories with the real scripts and the real worker code, under the systemd
# simulator (tests/ops/sim): nothing real is installed, every directory is a mktemp one and is removed at the end.
#
#   tests/transition/run.sh [<artifact dir>]
#
# Needs: git, node, pnpm (the pnpm store already holds the locked packages: run `pnpm install` in this checkout first),
# and DATABASE_URL pointing at a THROW-AWAY database (it is migrated, and the worker writes heartbeats into it).
# The artifact directory (default: none) receives the worker logs, the simulator's call log and each step's output.
#
# Scenarios, each on releases of real commits of a clone of this checkout (PREV = HEAD, NEXT = one commit on top, BROKEN
# = NEXT with a worker that throws on start):
#   1  first install of PREV (no worker before)
#   2  switch PREV -> NEXT (the worker step of a deploy)
#   3  switch NEXT -> BROKEN: the new worker gives no evidence, the switch is rolled back to NEXT
#   4  emergency restore of PREV (install --release of the previous release); the doctor reports release != HEAD
#   5  back to NEXT, then uninstall
# After each step: the service's MainPID runs from the expected release directory (its cwd), install-ai-worker.sh
# --print-release names it, and `pnpm run doctor --json` confirms the worker's shipped config report and finds no lock
# and no switch backup left. The doctor matches the worker's report against launchd on macOS and systemd on Linux, and
# the simulator here plays systemd: off Linux, the worker part of the doctor's report is not checked (CI runs on Linux).
set -euo pipefail

ARTIFACTS="${1:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SIM_BIN="$REPO/tests/ops/sim"
UNIT=job-radar-ai-worker.service

say() { printf '\n==> %s\n' "$*"; }
die() { echo "transition: $*" >&2; exit 1; }

[[ -n "${DATABASE_URL:-}" ]] || die "DATABASE_URL is not set (a throw-away database)"
for tool in git node pnpm; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done

root="$(mktemp -d "${TMPDIR:-/tmp}/transition.XXXXXX")" || die "mktemp failed"
[[ -n "$root" && -d "$root" && "$(basename "$root")" == transition.* ]] || die "mktemp gave no directory"
root="$(cd "$root" && pwd -P)"
main="$root/main"
DB_URL="$DATABASE_URL"
unset DATABASE_URL

cleanup() {
  local rc=$? pid
  trap - EXIT INT TERM HUP
  # every process the simulator started (each leads its own process group)
  if [[ -f "$root/sim/state.json" ]]; then
    for pid in $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((s.spawned||[]).join(" "))' "$root/sim/state.json" 2>/dev/null); do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  if [[ -n "$ARTIFACTS" ]]; then
    mkdir -p "$ARTIFACTS"
    cp -R "$main/data/logs" "$ARTIFACTS/worker-logs" 2>/dev/null || true
    cp "$root/sim/calls.log" "$ARTIFACTS/sim-calls.log" 2>/dev/null || true
    cp "$root"/step-*.log "$ARTIFACTS/" 2>/dev/null || true
  fi
  # release directories are read-only by design
  chmod -R u+w "$root" 2>/dev/null || true
  [[ -n "$root" && "$(basename "$root")" == transition.* ]] && rm -rf -- "$root"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

mkdir -p "$root/home" "$root/xdg" "$root/sim"
export HOME="$root/home" XDG_CONFIG_HOME="$root/xdg" JOB_RADAR_SERVICE_MANAGER=systemd JOB_RADAR_SIM_DIR="$root/sim"
export PATH="$SIM_BIN:$PATH"
unset NODE_OPTIONS JOB_RADAR_RELEASES_LOCK_TOKEN
DOCTOR_WORKER=1
if [[ "$(uname -s)" != Linux ]]; then
  DOCTOR_WORKER=0
  echo "note: not on Linux, so the doctor's check of the worker's report is skipped (the lock and backup checks still run)"
fi

# ---- the commits ------------------------------------------------------------------------------------------------------
say "clone and commits"
git clone -q --shared "$REPO" "$main"
git -C "$main" checkout -q -B main HEAD
git -C "$main" config user.email transition@example.invalid
git -C "$main" config user.name transition
PREV="$(git -C "$main" rev-parse HEAD)"
printf '\n' >> "$main/README.md"
git -C "$main" commit -q -am "transition: next"
NEXT="$(git -C "$main" rev-parse HEAD)"
{ echo 'throw new Error("transition test: this worker never starts");'; cat "$main/src/ai-worker/index.ts"; } > "$main/src/ai-worker/index.ts.new"
mv "$main/src/ai-worker/index.ts.new" "$main/src/ai-worker/index.ts"
git -C "$main" commit -q -am "transition: broken worker"
BROKEN="$(git -C "$main" rev-parse HEAD)"
git -C "$main" reset -q --hard "$NEXT"
echo "PREV $PREV  NEXT $NEXT  BROKEN $BROKEN"

say "dependencies and migrations of the checkout (the doctor runs from it)"
(cd "$main" && pnpm install --frozen-lockfile --prefer-offline --reporter=silent)
mkdir -p "$main/data/config" "$main/data/profile" "$main/data/logs"
(cd "$main" && pnpm --silent config:init)
(cd "$main" && DATABASE_URL="$DB_URL" pnpm --silent migrate:run)

release() { echo "$main/data/releases/ai-worker/$1"; }
prepare() {
  local out
  out="$(bash "$main/scripts/ops/prepare-release.sh" "$1" --root "$main")" || die "prepare-release.sh $1 failed"
  [[ "$out" == "$(release "$1")" ]] || die "prepare-release.sh printed $out"
}

# install <step> <release sha> <expected exit> [<text the output must contain>]
install() {
  local step="$1" sha="$2" want="$3" text="${4:-}" rc=0
  bash "$main/scripts/ops/install-ai-worker.sh" --release "$(release "$sha")" --root "$main" --database-url "$DB_URL" > "$root/step-$step.log" 2>&1 || rc=$?
  cat "$root/step-$step.log"
  [[ "$rc" == "$want" ]] || die "step $step: install-ai-worker.sh exited $rc, expected $want"
  [[ -z "$text" ]] || grep -qF -- "$text" "$root/step-$step.log" || die "step $step: the output lacks: $text"
}

worker_cwd() {
  if [[ -e "/proc/$1/cwd" ]]; then readlink "/proc/$1/cwd"; else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; fi
}

# doctor_json: the doctor's report of the worker's shipped config, the lock and the backup (warnings for the web and
# runner containers, which do not run here, are expected; exit 1 is fine)
doctor_json() {
  (cd "$main" && DATABASE_URL="$DB_URL" pnpm --silent run doctor --json --lang en --only config.shipped --only ops) || true
}

# check <step> <release sha> [<doctor text>]: the worker runs from that release; the doctor confirms its report (or,
# with a doctor text, reports exactly that problem) and sees no lock and no backup.
check() {
  local step="$1" sha="$2" want_doctor="${3:-}" pid cwd printed json verdict="" i
  pid="$(systemctl --user show "$UNIT" -p MainPID --value)"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || die "step $step: no MainPID ($pid)"
  cwd="$(worker_cwd "$pid")"
  [[ "$cwd" == "$(release "$sha")" ]] || die "step $step: the worker (pid $pid) runs from $cwd, expected $(release "$sha")"
  printed="$(bash "$main/scripts/ops/install-ai-worker.sh" --print-release --root "$main")" || die "step $step: --print-release failed"
  [[ "$printed" == "$(release "$sha")" ]] || die "step $step: --print-release says $printed"
  # the worker reports with every heartbeat: wait for a report of this PID
  for i in $(seq 1 30); do
    json="$(doctor_json)"
    verdict="$(node -e '
      const [json, want, worker] = [process.argv[1], process.argv[2], process.argv[3]];
      const r = JSON.parse(json); const by = (id) => r.checks.find((c) => c.id === id);
      const shipped = by("config.shipped"), lock = by("ops.releases_lock"), backup = by("ops.ai_worker_swap_backup");
      if (!shipped || !lock || !backup) { console.log("missing checks"); process.exit(0); }
      if (lock.status !== "ok" || backup.status !== "ok") { console.log(`lock ${lock.status}: ${lock.detail}; backup ${backup.status}: ${backup.detail}`); process.exit(0); }
      if (worker !== "1") { console.log("ok"); process.exit(0); }
      const problems = shipped.detail.split("; ").filter((p) => /^ai-worker(:| runs| has not)/.test(p));
      if (want === "" ? problems.length === 0 : problems.length === 1 && problems[0] === want) console.log("ok");
      else console.log(`config.shipped: ${shipped.detail}`);
    ' "$json" "$want_doctor" "$DOCTOR_WORKER")"
    [[ "$verdict" != ok ]] || break
    sleep 2
  done
  [[ "$verdict" == ok ]] || die "step $step: doctor: $verdict"
  echo "step $step: pid $pid runs $(release "$sha"); doctor ${want_doctor:-confirms the report}"
}

short() { printf '%s' "${1:0:12}"; }

say "1  first install of PREV"
prepare "$PREV"
install 1 "$PREV" 0
check 1 "$PREV" "ai-worker runs release $(short "$PREV"), the checkout is at $(short "$NEXT")"

say "2  switch PREV -> NEXT"
prepare "$NEXT"
install 2 "$NEXT" 0
check 2 "$NEXT"

say "3  switch to a worker that never starts: rolled back to NEXT"
prepare "$BROKEN"
install 3 "$BROKEN" 1 "rolled back:"
check 3 "$NEXT"

say "4  emergency restore of PREV"
install 4 "$PREV" 0
check 4 "$PREV" "ai-worker runs release $(short "$PREV"), the checkout is at $(short "$NEXT")"

say "5  back to NEXT, then uninstall"
install 5 "$NEXT" 0
check 5 "$NEXT"
pid="$(systemctl --user show "$UNIT" -p MainPID --value)"
bash "$main/scripts/ops/uninstall-ai-worker.sh" --root "$main" > "$root/step-6.log" 2>&1 || { cat "$root/step-6.log"; die "uninstall failed"; }
cat "$root/step-6.log"
for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
! kill -0 "$pid" 2>/dev/null || die "the worker (pid $pid) still runs after the uninstall"
rc=0; bash "$main/scripts/ops/install-ai-worker.sh" --print-release --root "$main" >/dev/null 2>&1 || rc=$?
[[ "$rc" == 3 ]] || die "--print-release after the uninstall exited $rc, expected 3"

say "all transition steps passed"
