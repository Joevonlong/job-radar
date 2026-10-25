#!/usr/bin/env bash
# Upgrade transitions with real Docker, the real deploy / install / uninstall scripts of each version and the real worker
# code, under the systemd simulator (tests/ops/sim): nothing on the host's launchd / systemd is touched, every checkout is
# a clone in a mktemp directory, and every compose project, image and volume is this run's own (jrtransition-<id>-*).
#
#   tests/transition/run.sh [--scenarios A,B] [<artifact dir>]
#
#   --scenarios  A, B or A,B (the default). C, D and E are no separate choices: they run inside B, on its project,
#                after B's upgrade to V4 (in the order D, C, E), so `--scenarios B` runs B, C, D and E.
#
# Needs: git with the full history of this checkout (62d7ad9 and later), node, pnpm (the store already holds the locked
# packages of every version: CI runs `pnpm install` first, the rest is fetched), Docker with compose v2. No database: each
# project runs its own db container on a free port. The artifact directory receives each step's output, the simulator's
# call log, the worker logs and, on failure, the compose logs.
#
# Versions: V0 = 62d7ad9 (before the shipped config work), V1 = 4dd8d03, V2 = 2656364 (config in the images), V3 = b3f69b0
# (release tooling), V4 = HEAD of this checkout (the worker runs from a release directory). Commits made here on top of
# V4: NEXT (a comment in config/ai.yaml, so its shipped config differs), BROKEN (V4 with a worker that throws at start),
# LOADER (NEXT plus an empty commit; its release gets a broken tsx loader).
#
# Scenario A (project a): V0 -> V1 -> V2 -> V3 -> V4, each hop as docs/upgrade.md says for it: check out the commit, run
#   its deploy.sh --skip-pull; before V2 also `docker compose stop web runner`; before V4 the first-upgrade steps
#   (uninstall the old worker, check that it stopped, stop web and runner, check out, deploy).
# Scenario B (project b): V0, then straight to V4:
#   B1  V4's install-ai-worker.sh --release BROKEN replaces the worker installed from the checkout: rolled back, the
#       checkout worker runs again (with evidence);
#   B2  V4's install --release V4 replaces it for real: the worker runs from the release while the checkout is still V0;
#   B3  the strict stop with V0's uninstall script, the checks of docs/upgrade.md, stop web and runner, check out V4,
#       V4's deploy.sh --skip-pull.
# Scenario D (project b, at V4): deploy NEXT with a runner image build that fails (build arg FAIL_RUNNER_BUILD=1 added
#   by the docker guard below): the deploy fails at the build; containers, images and the worker are unchanged and the
#   lock is gone; the same deploy without the build arg then succeeds.
# Scenario C (project b, at NEXT, after D): install --release LOADER whose tsx loader is broken: rolled back to NEXT with evidence.
# Scenario E (project b): the emergency restore of the previous release (prepare-release.sh V4 + install --release V4):
#   the V4 worker runs with evidence and the doctor reports release != HEAD; then the uninstall removes it.
#
# After every step: the compose containers' /app/config equals config/ of the deployed commit (sha256 of every file, in
#   web and runner); the worker's MainPID runs from the expected directory (the checkout, or the release); V4's
#   install-ai-worker.sh --print-release agrees (exit 4 for a worker from the checkout); a run_ai request for a finished
#   cycle is claimed and done by the worker; from V1 on the doctor's JSON has config.shipped, and from V4 on it confirms
#   the reports (containers and worker) and finds no release lock and no switch backup.
#
# Not covered here (see docs/ci.md): launchd (the integration tests run every case against the launchd simulator; real
# launchd is the manual drill), deploy.sh's own git pull (every hop uses --skip-pull after a checkout, the documented
# path for release tags). The doctor matches the worker's report against systemd only on Linux: off Linux that part of
# the check is skipped, and V0's uninstall script, which picks its service manager from `uname`, gets a uname that says
# Linux.
#
# Safety:
#   - environment: before anything runs, every compose, docker, database and job-radar variable of the caller's shell is
#     unset (clean-env.sh: COMPOSE_*, DOCKER_HOST / DOCKER_CONTEXT / DOCKER_TLS*, JOBRADAR_*, JOB_RADAR_*, POSTGRES_*,
#     PG*, DATABASE_URL and every name the compose files of V0 to V4 interpolate); each project's .env sets its own
#     project name, volume name, ports, bind address, uid / gid and database password
#   - docker: a guard first on PATH (docker-guard.sh) lets through read-only commands; compose commands that change
#     something run only for a project named jrtransition-<id>-* whose ports this run registered, and only after
#     `docker compose config` of that very command (same options, same environment) passed compose-check.mjs: every
#     volume named jrtransition-<id>-* and not external, every bind mount and build context inside the run's temporary
#     directory, no container_name, only the registered ports. prune, rm, volume rm, down and the rest are refused
#   - cleanup: a project is removed only after compose-check.mjs passed on its configuration and on the mounts of its
#     containers (docker inspect); `down` without -v, then only volumes whose names carry the project's prefix
#   - deploy.sh always runs with --no-prune and --no-backup; launchctl / systemctl resolve to the simulator (checked
#     before anything starts); `claude` and `codex` are stubs
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SIM_BIN="$REPO/tests/ops/sim"
UNIT=job-radar-ai-worker.service
V0=62d7ad9d93a08cf726958483673e01173e92aa9d
V1=4dd8d03d30ea5a8a8bfc75c5926c96ee95e5751e
V2=2656364ccf62aceca508cf05d214cc25e745cf47
V3=b3f69b09a72f1457a40bdd31393dc541623d8e4e

SCENARIOS="A,B"
ARTIFACTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenarios) [[ $# -ge 2 ]] || { echo "--scenarios needs a value" >&2; exit 1; }; SCENARIOS="$2"; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) ARTIFACTS="$1" ;;
  esac
  shift
done
for s in ${SCENARIOS//,/ }; do
  case "$s" in
    A|B) ;;
    C|D|E) echo "--scenarios: $s runs inside B (--scenarios B)" >&2; exit 1 ;;
    *) echo "--scenarios: unknown scenario '$s' (A, B)" >&2; exit 1 ;;
  esac
done

# Before anything runs: no compose, docker or database setting of the caller's shell reaches docker or the scripts
# under test (each project gets its own values in its .env; see clean-env.sh).
# shellcheck source=tests/transition/clean-env.sh
source "$REPO/tests/transition/clean-env.sh"
transition_clean_env < <(cat "$REPO"/compose*.yaml 2>/dev/null; for c in "$V0" "$V1" "$V2" "$V3"; do git -C "$REPO" show "$c:compose.yaml" 2>/dev/null; done)

say() { printf '\n==> %s\n' "$*"; }
die() { echo "transition: FAILED: $*" >&2; exit 1; }
want() { [[ ",$SCENARIOS," == *",$1,"* ]]; }

for tool in git node pnpm docker; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
REAL_DOCKER="$(command -v docker)"
"$REAL_DOCKER" compose version >/dev/null 2>&1 || die "docker compose (v2) is not available"
for c in "$V0" "$V1" "$V2" "$V3"; do
  git -C "$REPO" cat-file -e "$c^{commit}" 2>/dev/null || die "commit $c is missing: this needs the full history (actions/checkout with fetch-depth: 0)"
done
V4="$(git -C "$REPO" rev-parse HEAD)"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || echo "note: this checkout has uncommitted changes; V4 is its HEAD commit $V4, without them"

root="$(mktemp -d "${TMPDIR:-/tmp}/transition.XXXXXX")" || die "mktemp failed"
[[ -n "$root" && -d "$root" && "$(basename "$root")" == transition.* ]] || die "mktemp gave no directory"
root="$(cd "$root" && pwd -P)"
RUN_ID="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 8)" || true
[[ "$RUN_ID" =~ ^[a-z0-9]{8}$ ]] || die "could not make a run id"
PREFIX="jrtransition-$RUN_ID"
PROJECTS=()   # "<project> <dir>" of every compose project this run started

collect_artifacts() {
  local p dir
  [[ -n "$ARTIFACTS" ]] || return 0
  mkdir -p "$ARTIFACTS"
  cp "$root"/step-*.log "$ARTIFACTS/" 2>/dev/null || true
  cp "$root/sim/calls.log" "$ARTIFACTS/sim-calls.log" 2>/dev/null || true
  for p in ${PROJECTS[@]+"${PROJECTS[@]}"}; do
    dir="${p#* }"; p="${p%% *}"
    cp -R "$dir/data/logs" "$ARTIFACTS/worker-logs-${p#"$PREFIX-"}" 2>/dev/null || true
    (cd "$dir" && "$REAL_DOCKER" compose -p "$p" logs --no-color --tail 300 > "$ARTIFACTS/compose-${p#"$PREFIX-"}.log" 2>&1) || true
  done
}

# teardown_project <project> <dir>: removes the project's containers, network and built images, then the volumes named
# <project>-...; only after its containers' mounts (docker inspect) and its configuration (compose config) were checked
# to be this run's (compose-check.mjs). Never `down -v`: a volume is removed only by a name that carries the run's prefix.
teardown_project() {
  local p="$1" dir="$2" ids v
  [[ "$p" == "$PREFIX"-?* ]] || { echo "transition: not removing $p: not a project of this run" >&2; return 1; }
  ids="$("$REAL_DOCKER" ps -aq --filter "label=com.docker.compose.project=$p")"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    "$REAL_DOCKER" inspect $ids | node "$REPO/tests/transition/compose-check.mjs" inspect "$p" "$PREFIX-" "$root" \
      || { echo "transition: NOT removing project $p: its containers mount something that is not this run's (above); remove it by hand" >&2; return 1; }
  fi
  if [[ -d "$dir" ]]; then
    (cd "$dir" && "$REAL_DOCKER" compose -p "$p" config --format json 2>/dev/null) \
      | node "$REPO/tests/transition/compose-check.mjs" config "$p" "$PREFIX-" "$root" "$root/projects/$p.ports" \
      || { echo "transition: NOT removing project $p: its configuration is not this run's (above); remove it by hand" >&2; return 1; }
    (cd "$dir" && "$REAL_DOCKER" compose -p "$p" down --rmi local --remove-orphans >/dev/null 2>&1) || true
  fi
  for v in $("$REAL_DOCKER" volume ls -q --filter "label=com.docker.compose.project=$p") "$p-pg"; do
    [[ "$v" == "$p"-?* ]] || continue
    "$REAL_DOCKER" volume inspect "$v" >/dev/null 2>&1 || continue
    "$REAL_DOCKER" volume rm "$v" >/dev/null 2>&1 || echo "transition: could not remove volume $v" >&2
  done
  return 0
}

cleanup() {
  local rc=$? pid p dir
  trap - EXIT INT TERM HUP
  set +e
  (( rc == 0 )) || collect_artifacts
  if (( rc == 0 )) && [[ -n "$ARTIFACTS" ]]; then mkdir -p "$ARTIFACTS"; cp "$root"/step-*.log "$ARTIFACTS/" 2>/dev/null; fi
  # every process the simulator started (each leads its own process group)
  if [[ -f "$root/sim/state.json" ]]; then
    for pid in $(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((s.spawned||[]).join(" "))' "$root/sim/state.json" 2>/dev/null); do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    done
  fi
  # this run's compose projects only, each checked first (teardown_project)
  for p in ${PROJECTS[@]+"${PROJECTS[@]}"}; do
    dir="${p#* }"; p="${p%% *}"
    teardown_project "$p" "$dir" || { (( rc != 0 )) || rc=1; }
  done
  chmod -R u+w "$root" 2>/dev/null
  [[ -n "$root" && "$(basename "$root")" == transition.* ]] && rm -rf -- "$root"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---- the environment: simulator, stubs, docker guard ------------------------------------------------------------------
mkdir -p "$root/home" "$root/xdg" "$root/run" "$root/sim" "$root/bin" "$root/uname-linux"
chmod 700 "$root/run"
FAIL_FLAG="$root/fail-runner-build"
mkdir -p "$root/projects"
# the guard (docker-guard.sh) with this run's settings baked in: the scripts under test cannot change them
cat > "$root/bin/docker" <<EOF
#!/usr/bin/env bash
TRANSITION_REAL_DOCKER='$REAL_DOCKER' TRANSITION_PREFIX='$PREFIX-' TRANSITION_ROOT='$root' TRANSITION_FAIL_FLAG='$FAIL_FLAG' \\
  exec bash '$REPO/tests/transition/docker-guard.sh' "\$@"
EOF
for tool in claude codex; do
  printf '#!/bin/sh\n# transition stub: no AI provider here\n[ "$1" = --version ] && { echo "0.0.0 (transition stub)"; exit 0; }\necho "%s: transition stub" >&2\nexit 1\n' "$tool" > "$root/bin/$tool"
done
printf '#!/bin/sh\n[ "$1" = -s ] && { echo Linux; exit 0; }\nexec /usr/bin/uname "$@"\n' > "$root/uname-linux/uname"
chmod 755 "$root/bin/"* "$root/uname-linux/uname"

# the docker CLI finds its plugins (compose) and its context through its config directory, which follows HOME
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
export HOME="$root/home" XDG_CONFIG_HOME="$root/xdg" XDG_RUNTIME_DIR="$root/run" JOB_RADAR_SERVICE_MANAGER=systemd JOB_RADAR_SIM_DIR="$root/sim"
export PATH="$root/bin:$SIM_BIN:$PATH"
# every launchctl / systemctl the scripts run must be the simulator's
[[ "$(command -v launchctl)" == "$SIM_BIN/launchctl" && "$(command -v systemctl)" == "$SIM_BIN/systemctl" ]] \
  || die "launchctl / systemctl do not resolve to the simulator ($(command -v launchctl), $(command -v systemctl))"
[[ "$(command -v docker)" == "$root/bin/docker" ]] || die "the docker guard is not first on PATH"
ON_LINUX=1
if [[ "$(uname -s)" != Linux ]]; then
  ON_LINUX=0
  echo "note: not on Linux: the doctor's check of the worker's report is skipped, and V0's uninstall gets a uname that says Linux"
fi

# ---- commits -----------------------------------------------------------------------------------------------------------
say "source clone and the commits on top of V4 ($V4)"
src="$root/src"
git clone -q --no-checkout "$REPO" "$src"
git -C "$src" checkout -q -B main "$V4"
git -C "$src" config user.email transition@example.invalid
git -C "$src" config user.name transition
printf '# transition test: next\n' >> "$src/config/ai.yaml"
git -C "$src" commit -q -am "transition: next"
NEXT="$(git -C "$src" rev-parse HEAD)"
git -C "$src" commit -q --allow-empty -m "transition: loader"
LOADER="$(git -C "$src" rev-parse HEAD)"
git -C "$src" checkout -q -B broken "$V4"
{ echo 'throw new Error("transition test: this worker never starts");'; cat "$src/src/ai-worker/index.ts"; } > "$src/src/ai-worker/index.ts.new"
mv "$src/src/ai-worker/index.ts.new" "$src/src/ai-worker/index.ts"
git -C "$src" commit -q -am "transition: broken worker"
BROKEN="$(git -C "$src" rev-parse HEAD)"
git -C "$src" branch -q -f next "$NEXT"
git -C "$src" branch -q -f loader "$LOADER"
git -C "$src" checkout -q main
echo "V0 $V0  V1 $V1  V2 $V2  V3 $V3  V4 $V4"
echo "NEXT $NEXT  LOADER $LOADER  BROKEN $BROKEN"

short() { printf '%s' "${1:0:12}"; }
free_port() {
  local p
  while :; do
    p="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    [[ "$p" != 5433 && "$p" != 3000 ]] && { echo "$p"; return; }
  done
}

# ---- one project ---------------------------------------------------------------------------------------------------------
# project_new <name> <commit>: a clone at <commit> with its own compose project, ports, volume and database password;
# the user's schedule.yaml turns the scheduled cycles and the catch-up off (no collection runs, so run_ai finds nothing
# to send to an AI provider).
P="" DIR="" DB_URL="" WEB_PORT=""
project_new() {
  local name="$1" sha="$2" db_port pw
  P="$PREFIX-$name"; DIR="$root/$name"
  git clone -q "$src" "$DIR"
  git -C "$DIR" checkout -q --detach "$sha"
  db_port="$(free_port)"; WEB_PORT="$(free_port)"
  pw="$(LC_ALL=C tr -dc 'a-z0-9' < /dev/urandom | head -c 20)" || true
  DB_URL="postgres://jobradar:$pw@127.0.0.1:$db_port/jobradar"
  cat > "$DIR/.env" <<EOF
COMPOSE_PROJECT_NAME=$P
JOBRADAR_PG_VOLUME=$P-pg
POSTGRES_USER=jobradar
POSTGRES_PASSWORD=$pw
POSTGRES_DB=jobradar
DB_HOST_PORT=$db_port
JOB_RADAR_WEB_PORT=$WEB_PORT
JOB_RADAR_WEB_BIND=127.0.0.1
PUID=$(id -u)
PGID=$(id -g)
DATABASE_URL=$DB_URL
EOF
  # the docker guard starts only projects with registered ports, and only on these
  printf '%s\n%s\n' "$db_port" "$WEB_PORT" > "$root/projects/$P.ports"
  mkdir -p "$DIR/data/config"
  sed -e 's/^catch_up: true/catch_up: false/' -e 's/^\(    enabled:\) true/\1 false/' "$DIR/config/schedule.yaml" > "$DIR/data/config/schedule.yaml"
  PROJECTS+=("$P $DIR")
  echo "project $P in $DIR: db 127.0.0.1:$db_port, web 127.0.0.1:$WEB_PORT"
}

# in_project <command…>: in the checkout, with the project's name and doctor URL in the environment
in_project() { (cd "$DIR" && COMPOSE_PROJECT_NAME="$P" JOB_RADAR_DOCTOR_WEB_URL="http://127.0.0.1:$WEB_PORT" "$@"); }

STEP=0
# logged <label> <want rc list> <command…>: runs it with its output in step-<n>-<label>.log (and on the console)
logged() {
  local label="$1" want="$2" rc=0 log
  shift 2
  STEP=$((STEP + 1)); log="$root/step-$(printf '%02d' "$STEP")-$label.log"
  echo "-- step $STEP: $label: $*"
  "$@" > "$log" 2>&1 || rc=$?
  tail -n 40 "$log"
  [[ " $want " == *" $rc "* ]] || die "step $STEP ($label): exit $rc, expected one of: $want (full output: $log)"
  LAST_LOG="$log"
}
LAST_LOG=""
log_has() { grep -qF -- "$1" "$LAST_LOG" || die "step $STEP: the output lacks: $1"; }
log_lacks() { ! grep -qF -- "$1" "$LAST_LOG" || die "step $STEP: the output has: $1"; }

deploy() { logged "deploy-$1" "0 2" in_project bash scripts/ops/deploy.sh --skip-pull --no-backup --no-prune --no-drain --settle "${2:-5}" --wait-timeout 600; }
checkout() { git -C "$DIR" checkout -q --detach "$1"; }
stop_web_runner() { logged stop-web-runner 0 in_project docker compose -p "$P" stop web runner; }
release_of() { echo "$DIR/data/releases/ai-worker/$1"; }

# ---- checks ----------------------------------------------------------------------------------------------------------------
worker_pid() { systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || true; }
worker_cwd() {
  if [[ -e "/proc/$1/cwd" ]]; then readlink "/proc/$1/cwd"; else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; fi
}
# workers_left: the PIDs of ai-worker processes that run from this run's directories (other workers on the host are not ours)
workers_left() {
  local pid cwd
  for pid in $(ps -A -o pid=,command= | awk '/src\/ai-worker\/index\.ts/ { print $1 }'); do
    cwd="$(worker_cwd "$pid" 2>/dev/null)" || continue
    [[ "$cwd" == "$root"/* ]] && echo "$pid"
  done
  return 0
}

HASH_JS='const fs=require("fs"),p=require("path"),c=require("crypto");const base=process.argv[1];const out=[];
const walk=(d)=>{for(const n of fs.readdirSync(p.join(base,d)).sort()){const r=d?d+"/"+n:n;const st=fs.lstatSync(p.join(base,r));
if(st.isDirectory())walk(r);else if(st.isFile())out.push(c.createHash("sha256").update(fs.readFileSync(p.join(base,r))).digest("hex")+"  "+r);else out.push("other  "+r);}};
walk("");console.log(out.sort().join("\n"));'
# check_manifest <commit>: /app/config of the web and runner containers equals config/ of <commit>
check_manifest() {
  local sha="$1" exp got svc tmp
  tmp="$(mktemp -d "$root/manifest.XXXXXX")"
  git -C "$src" archive "$sha" config | tar -x -C "$tmp"
  exp="$(node -e "$HASH_JS" "$tmp/config")"
  for svc in web runner; do
    got="$(in_project docker compose -p "$P" exec -T "$svc" node -e "$HASH_JS" /app/config)" || die "step $STEP: cannot read /app/config in $svc"
    if [[ "$got" != "$exp" ]]; then
      diff <(printf '%s\n' "$exp") <(printf '%s\n' "$got") | head -n 20 >&2 || true
      die "step $STEP: /app/config in $svc differs from config/ of $(short "$sha")"
    fi
  done
  rm -rf "$tmp"
  echo "check: /app/config of web and runner = config/ of $(short "$sha") ($(printf '%s\n' "$exp" | wc -l | tr -d ' ') files)"
}

# check_worker <dir> [checkout|release]: the service's MainPID runs from <dir>; V4's --print-release agrees
check_worker() {
  local dir="$1" kind="${2:-release}" pid cwd printed rc=0 i
  for i in $(seq 1 30); do pid="$(worker_pid)"; [[ "$pid" =~ ^[1-9][0-9]*$ ]] && break; sleep 1; done
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || die "step $STEP: no MainPID for $UNIT"
  cwd="$(worker_cwd "$pid")"
  [[ "$cwd" == "$dir" ]] || die "step $STEP: the worker (pid $pid) runs from $cwd, expected $dir"
  printed="$(bash "$REPO/scripts/ops/install-ai-worker.sh" --print-release --root "$DIR" 2>/dev/null)" || rc=$?
  if [[ "$kind" == checkout ]]; then
    [[ "$rc" == 4 ]] || die "step $STEP: --print-release exited $rc for a worker from the checkout, expected 4"
  else
    [[ "$rc" == 0 && "$printed" == "$dir" ]] || die "step $STEP: --print-release exited $rc and printed '$printed', expected $dir"
  fi
  WORKER_PID="$pid"
  echo "check: worker pid $pid runs from $dir"
}
WORKER_PID=""

# check_run_ai: a run_ai request for a finished cycle is claimed and done by the worker (within 120 s)
check_run_ai() {
  local verdict
  verdict="$(node -e '
    const postgres = require(process.argv[1]);
    const sql = postgres(process.argv[2], { max: 1, onnotice: () => {} });
    (async () => {
      const [c] = await sql`insert into cycles (kind, status, started_at, finished_at) values (${"manual"}, ${"succeeded"}, now(), now()) returning id`;
      const [r] = await sql`insert into control_requests (kind, payload) values (${"run_ai"}, ${sql.json({ cycleId: Number(c.id) })}) returning id`;
      const until = Date.now() + 120000;
      let row;
      for (;;) {
        [row] = await sql`select status, result from control_requests where id = ${r.id}`;
        if (row.status === "done" || row.status === "failed" || Date.now() > until) break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      console.log(row.status === "done" ? "done" : `${row.status} ${JSON.stringify(row.result)}`);
      await sql.end({ timeout: 2 });
    })().catch((e) => { console.log(`error ${e.message}`); process.exit(0); });
  ' "$REPO/node_modules/postgres" "$DB_URL")"
  [[ "$verdict" == done ]] || die "step $STEP: run_ai: $verdict"
  echo "check: run_ai done"
}

# check_doctor <level> [<expected worker problem>]: level 1 = the JSON has config.shipped; 4 = it confirms the reports
# (containers and, on Linux, the worker; or exactly the expected worker problem) and no lock / backup is left
check_doctor() {
  local level="$1" want="${2:-}" json verdict="" i
  for i in $(seq 1 30); do
    json="$(in_project pnpm --silent run doctor --json --lang en --only config.shipped --only ops 2>/dev/null)" || true
    verdict="$(node -e '
      const [json, level, want, linux] = process.argv.slice(1);
      let r; try { r = JSON.parse(json); } catch { console.log("no JSON"); process.exit(0); }
      const by = (id) => r.checks.find((c) => c.id === id);
      const shipped = by("config.shipped");
      if (!shipped) { console.log("no config.shipped"); process.exit(0); }
      if (level === "1") { console.log("ok"); process.exit(0); }
      const lock = by("ops.releases_lock"), backup = by("ops.ai_worker_swap_backup");
      if (!lock || !backup) { console.log("missing ops checks"); process.exit(0); }
      if (lock.status !== "ok" || backup.status !== "ok") { console.log(`lock ${lock.status}: ${lock.detail}; backup ${backup.status}: ${backup.detail}`); process.exit(0); }
      // the detail lists the problems, then the confirmed processes ("web <id>"); only the problems count here
      const problems = shipped.status === "ok" ? [] : shipped.detail.split("; ").filter((p) => !/^(web|runner|ai-worker) \S+$/.test(p));
      const worker = problems.filter((p) => p.startsWith("ai-worker"));
      const others = problems.filter((p) => !p.startsWith("ai-worker"));
      if (others.length) { console.log(`config.shipped: ${shipped.detail}`); process.exit(0); }
      if (linux !== "1") { console.log("ok"); process.exit(0); }
      if (want === "" ? worker.length === 0 : worker.length === 1 && worker[0] === want) console.log("ok");
      else console.log(`config.shipped: ${shipped.detail}`);
    ' "$json" "$level" "$want" "$ON_LINUX")"
    [[ "$verdict" != ok ]] || break
    sleep 2
  done
  [[ "$verdict" == ok ]] || die "step $STEP: doctor: $verdict"
  if [[ "$level" == 1 ]]; then echo "check: the doctor's JSON has config.shipped"
  elif (( ON_LINUX )); then echo "check: doctor ${want:-confirms the reports}"
  else echo "check: doctor confirms the container reports, no lock, no backup (its worker check needs Linux)"; fi
}

check_no_lock() {
  [[ ! -e "$DIR/data/releases/ai-worker/.lock" ]] || die "step $STEP: the release lock is still there"
  [[ ! -e "$DIR/data/run/ai-worker-swap-backup" ]] || die "step $STEP: a switch backup is left"
}

# check_all <commit> <worker dir> <checkout|release> <doctor level> [<expected worker problem>]
check_all() {
  check_manifest "$1"
  check_worker "$2" "$3"
  check_run_ai
  case "$4" in
    0) ;;
    1) check_doctor 1 ;;
    4) check_doctor 4 "${5:-}"; check_no_lock ;;
  esac
}

# strict_stop <uninstall script>: docs/upgrade.md, first upgrade, steps 1 and 2 (Linux)
strict_stop() {
  local script="$1" pid i state
  pid="$(worker_pid)"
  if (( ON_LINUX )); then logged uninstall-old 0 in_project bash "$script"
  else logged uninstall-old 0 in_project env PATH="$root/uname-linux:$PATH" bash "$script"; fi
  for i in $(seq 1 30); do
    state="$(systemctl --user is-active job-radar-ai-worker 2>/dev/null || true)"
    [[ "$state" != active && -z "$(workers_left)" ]] && break
    sleep 1
  done
  [[ "$state" != active ]] || die "step $STEP: systemctl --user is-active job-radar-ai-worker is still active"
  [[ -z "$(workers_left)" ]] || die "step $STEP: ai-worker processes still run: $(workers_left | tr '\n' ' ')"
  [[ -z "$pid" || "$pid" == 0 ]] || ! kill -0 "$pid" 2>/dev/null || die "step $STEP: the old worker (pid $pid) still runs"
  echo "check: the old worker is stopped (is-active: ${state:-none}, no worker process of this run)"
}

# ==== scenario A ============================================================================================================
if want A; then
  say "A: V0 -> V1 -> V2 -> V3 -> V4, each hop as documented"
  project_new a "$V0"
  deploy a-v0
  check_all "$V0" "$DIR" checkout 0

  checkout "$V1"; deploy a-v1
  check_all "$V1" "$DIR" checkout 1

  stop_web_runner; checkout "$V2"; deploy a-v2
  check_all "$V2" "$DIR" checkout 1

  checkout "$V3"; deploy a-v3
  check_all "$V3" "$DIR" checkout 1

  strict_stop "$DIR/scripts/ops/uninstall-ai-worker.sh"
  stop_web_runner; checkout "$V4"; deploy a-v4 60
  log_has "confirmed: lock, heartbeat and config report"
  check_all "$V4" "$(release_of "$V4")" release 4

  # A is done: its worker goes (B installs the same unit) and its containers too, before B builds
  logged a-uninstall 0 in_project bash scripts/ops/uninstall-ai-worker.sh
  [[ -z "$(workers_left)" ]] || die "scenario A's worker still runs after the uninstall"
  teardown_project "$P" "$DIR" || die "scenario A's project could not be removed safely"
fi

# ==== scenarios B, D, C, E ==================================================================================================
if want B; then
  say "B: V0, then straight to V4 (with a failed and a real replacement of the checkout worker first)"
  project_new b "$V0"
  deploy b-v0
  check_all "$V0" "$DIR" checkout 0

  # B1: V4's tools replace the worker installed from the checkout with a worker that never starts: rolled back
  logged b1-prepare-broken 0 bash "$REPO/scripts/ops/prepare-release.sh" "$BROKEN" --root "$DIR"
  old_pid="$(worker_pid)"
  logged b1-install-broken 1 bash "$REPO/scripts/ops/install-ai-worker.sh" --release "$(release_of "$BROKEN")" --root "$DIR"
  log_has "rolled back:"; log_has "the previous worker is back"; log_lacks "ROLLBACK FAILED"
  check_all "$V0" "$DIR" checkout 0
  [[ "$WORKER_PID" != "$old_pid" ]] || die "step $STEP: the worker was not restarted"

  # B2: and for real: the worker runs from the release of V4 while the checkout is still at V0
  logged b2-prepare-v4 0 bash "$REPO/scripts/ops/prepare-release.sh" "$V4" --root "$DIR"
  logged b2-install-v4 0 bash "$REPO/scripts/ops/install-ai-worker.sh" --release "$(release_of "$V4")" --root "$DIR"
  check_worker "$(release_of "$V4")" release
  check_run_ai
  check_no_lock

  # B3: the strict stop with V0's uninstall, then the first upgrade to V4
  strict_stop "$DIR/scripts/ops/uninstall-ai-worker.sh"
  stop_web_runner; checkout "$V4"; deploy b-v4 60
  log_has "confirmed: lock, heartbeat and config report"
  check_all "$V4" "$(release_of "$V4")" release 4

  say "D: a deploy whose runner image fails to build changes nothing; the same deploy then succeeds"
  checkout "$NEXT"
  ids_before="$(in_project docker compose -p "$P" ps -q web runner | sort)"
  images_before="$(for c in $ids_before; do docker inspect -f '{{.Image}}' "$c"; done)"
  pid_before="$(worker_pid)"
  touch "$FAIL_FLAG"
  logged d-deploy-fails 1 in_project bash scripts/ops/deploy.sh --skip-pull --no-backup --no-prune --no-drain --settle 60 --wait-timeout 600
  log_has "FAIL_RUNNER_BUILD is set"
  rm -f "$FAIL_FLAG"
  [[ "$(in_project docker compose -p "$P" ps -q web runner | sort)" == "$ids_before" ]] || die "step $STEP: the web / runner containers changed"
  [[ "$(for c in $ids_before; do docker inspect -f '{{.Image}}' "$c"; done)" == "$images_before" ]] || die "step $STEP: the containers' images changed"
  [[ "$(in_project docker compose -p "$P" ps --status running -q web runner | wc -l | tr -d ' ')" == 2 ]] || die "step $STEP: web and runner are not both running"
  [[ "$(worker_pid)" == "$pid_before" ]] || die "step $STEP: the worker was restarted"
  [[ -z "$(ls -A "$DIR/data/build" 2>/dev/null)" ]] || die "step $STEP: a build context is left in data/build"
  check_all "$V4" "$(release_of "$V4")" release 4 "ai-worker runs release $(short "$V4"), the checkout is at $(short "$NEXT")"
  deploy d-deploy-again 60
  log_has "confirmed: lock, heartbeat and config report"
  check_all "$NEXT" "$(release_of "$NEXT")" release 4

  say "C: a release with a broken tsx loader: the switch is rolled back to NEXT"
  logged c-prepare-loader 0 in_project bash scripts/ops/prepare-release.sh "$LOADER" --root "$DIR"
  loader="$(release_of "$LOADER")/node_modules/tsx/dist/loader.mjs"
  loader="$(cd "$(dirname "$loader")" && pwd -P)/loader.mjs"
  [[ "$loader" == "$(release_of "$LOADER")"/* ]] || die "the loader $loader is not inside the release"
  # unlink and write a new file: the old one may be a hard link into the pnpm store, which must not change
  chmod u+w "$(dirname "$loader")"; rm -f -- "$loader"
  echo 'throw new Error("transition test: broken tsx loader");' > "$loader"; chmod a-w "$(dirname "$loader")"
  logged c-install-loader 1 in_project bash scripts/ops/install-ai-worker.sh --release "$(release_of "$LOADER")" --root "$DIR"
  log_has "rolled back:"; log_has "the previous worker is back"; log_lacks "ROLLBACK FAILED"
  check_all "$NEXT" "$(release_of "$NEXT")" release 4

  say "E: emergency restore of the previous release (V4)"
  logged e-prepare-prev 0 in_project bash scripts/ops/prepare-release.sh "$V4" --root "$DIR"
  logged e-install-prev 0 in_project bash scripts/ops/install-ai-worker.sh --release "$(release_of "$V4")" --root "$DIR"
  check_all "$NEXT" "$(release_of "$V4")" release 4 "ai-worker runs release $(short "$V4"), the checkout is at $(short "$NEXT")"

  say "uninstall"
  pid="$(worker_pid)"
  logged uninstall 0 in_project bash scripts/ops/uninstall-ai-worker.sh
  for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  ! kill -0 "$pid" 2>/dev/null || die "the worker (pid $pid) still runs after the uninstall"
  rc=0; bash "$DIR/scripts/ops/install-ai-worker.sh" --print-release --root "$DIR" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 3 ]] || die "--print-release after the uninstall exited $rc, expected 3"
fi

say "all transition scenarios passed ($SCENARIOS)"
