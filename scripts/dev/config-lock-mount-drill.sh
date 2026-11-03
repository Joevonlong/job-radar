#!/usr/bin/env bash
# Does the config write lock hold across a Docker Desktop bind mount? The writers of one install run in a container and on
# the Mac at the same time, and the lock only works if what one side published is what the other reads once it holds
# the lock. This drill measures that on this machine; it is not part of CI (macOS with Docker only).
#
#   scripts/dev/config-lock-mount-drill.sh [--count N] [--rounds N] [--parent DIR] [--project NAME] [--raw-read]
#
#   --count N       increments per side (default 500; the total must come out as 2N)
#   --rounds N      link + unlink rounds per side (default 100)
#   --parent DIR    where the temp directory goes; choose the volume the real data lives on (default: the system's temp)
#   --project NAME  compose project of the drill; must start with config-lock-drill (default: config-lock-drill-<pid>)
#   --raw-read      read with a plain fs.readFile instead of the app's reader: shows the gap the reader has to cover (fails
#                   when the mount has one)
#
# Counter: under a Postgres advisory lock with the key of the config write lock, the two sides take strict turns: each one
# reads the file with the app's reader (src/lib/config/read-user-file.ts), compares its hash with what the last holder
# recorded in the database, writes a temp file, fsyncs, renames over the file and records the new hash: the same steps as a
# real commit. Every read must return the published text at once; each side also checks that a file nobody has still
# reads as absent. Links: each side publishes with link + unlink under the lock; the second one must get EEXIST and read
# the first one's whole file. "gaps" in the result are the times the reader had to wait for the mount: covered, not failures.
#
# It only uses a temp directory and a throw-away compose project of its own (compose file in the temp directory, database
# on tmpfs, removed at the end, also on an interrupt): nothing of an install. Exit 0 = the mount holds, 1 = it does not, 2 =
# cannot run here.
set -euo pipefail

count=500
rounds=100
parent="${TMPDIR:-/tmp}"
project="config-lock-drill-$$"
raw_read=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) count="${2:-}"; shift 2 ;;
    --rounds) rounds="${2:-}"; shift 2 ;;
    --parent) parent="${2:-}"; shift 2 ;;
    --project) project="${2:-}"; shift 2 ;;
    --raw-read) raw_read=1; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$count" =~ ^[1-9][0-9]*$ && "$rounds" =~ ^[1-9][0-9]*$ ]] || { echo "--count and --rounds need a positive whole number" >&2; exit 2; }
[[ "$project" =~ ^config-lock-drill[a-z0-9_-]*$ ]] || { echo "--project must start with config-lock-drill (lower case, digits, - and _): the drill never touches another project" >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo "this drill is for Docker Desktop on macOS" >&2; exit 2; }
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "docker is not running" >&2; exit 2; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 2; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -d "$repo/node_modules/postgres" ]] || { echo "run pnpm install first (the drill uses the postgres package)" >&2; exit 2; }
postgres_pkg="$(cd "$repo/node_modules/postgres" && pwd -P)"
[[ -d "$parent" ]] || { echo "--parent $parent is not a directory" >&2; exit 2; }
work="$(mktemp -d "$(cd "$parent" && pwd -P)/config-lock-drill.XXXXXX")"
host_pid=""
# Run in the temp directory, so no .env or override of this checkout comes along; -p wins over COMPOSE_PROJECT_NAME.
drill_compose() { (cd "$work" && unset COMPOSE_FILE && docker compose -p "$project" -f "$work/compose.yaml" "$@"); }

cleanup() {
  [[ -z "$host_pid" ]] || kill "$host_pid" 2>/dev/null || true
  [[ ! -f "$work/compose.yaml" ]] || drill_compose down --remove-orphans --timeout 2 >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir "$work/config" "$work/out"
cp "$repo/src/lib/config/read-user-file.ts" "$work/read-user-file.ts"
cat >"$work/worker.mjs" <<'WORKER'
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

import { readUserFile } from "./read-user-file.ts";

const { side, dir, url, pkg, count, rounds, out, raw } = process.env;
const { default: postgres } = await import(`${pkg}/src/index.js`);
const sql = postgres(url, { max: 1, onnotice: () => {} });
const KEY = [0x4a52, 0x0003];
const sha = (text) => createHash("sha256").update(text).digest("hex");
const counter = path.join(dir, "counter.yaml");
const result = { side, increments: 0, stale: 0, staleOld: 0, staleMissing: 0, errorCodes: [], behindMax: 0, gaps: 0, gapMsMax: 0, won: 0, lost: 0, errors: [] };

const noteGap = (waited) => {
  result.gaps += 1;
  result.gapMsMax = Math.max(result.gapMsMax, waited);
};
const read = async (file) => (raw === "1" ? fs.readFile(file, "utf8") : readUserFile(file, noteGap).toString("utf8"));

async function publishable(file, text) {
  const handle = await fs.open(file, "wx", 0o600);
  await handle.writeFile(text);
  await handle.sync();
  await handle.close();
}

async function withLock(task) {
  while (!(await sql`select pg_try_advisory_lock(${KEY[0]}::int, ${KEY[1]}::int) as ok`)[0].ok) await sleep(5);
  try {
    return await task();
  } finally {
    await sql`select pg_advisory_unlock(${KEY[0]}::int, ${KEY[1]}::int)`;
  }
}

// What the last holder published, as the app reads it: anything else on the first read is a failure of this drill.
async function readPublished() {
  const [{ value, hash }] = await sql`select value, hash from drill_counter`;
  const text = await read(counter).catch((error) => `unreadable: ${error.code}`);
  if (sha(text) === hash) return value;
  result.stale += 1;
  const seen = /^counter: (\d+)$/m.exec(text);
  if (seen === null) {
    result.staleMissing += 1;
    if (!result.errorCodes.includes(text)) result.errorCodes.push(text);
    // the next turn needs the file: wait the gap out, this read is already counted
    for (const started = Date.now(); Date.now() - started < 5000; await sleep(10)) {
      const again = await fs.readFile(counter, "utf8").catch(() => "");
      if (sha(again) === hash) break;
    }
  } else {
    result.staleOld += 1;
    result.behindMax = Math.max(result.behindMax, value - Number(seen[1]));
  }
  return value;
}

// A file nobody has must still read as absent, and without waiting: the gap's cover must not hide a real miss.
async function checkAbsent(i) {
  const started = Date.now();
  const code = await read(path.join(dir, `absent-${side}-${i}.yaml`)).then(() => "read", (error) => error.code);
  if (code !== "ENOENT") throw new Error(`a file nobody has read as ${code}`);
  if (Date.now() - started > 1000) throw new Error(`a file nobody has took ${Date.now() - started} ms to read as absent`);
}

// Strict turns: every read comes right after the other side replaced the file, the case that can show a gap.
async function myTurn() {
  const [{ last_side: last }] = await sql`select last_side from drill_counter`;
  return last !== side;
}

// Both sides start together: a side that finished before the container came up would prove nothing.
async function barrier(name) {
  await sql`insert into drill_ready (name, side) values (${name}, ${side})`;
  while ((await sql`select count(*)::int as n from drill_ready where name = ${name}`)[0].n < 2) await sleep(5);
}

await barrier("counter");
for (let i = 0; i < Number(count); i += 1) {
  try {
    for (let done = false; !done; ) {
      done = await withLock(async () => {
        if (!(await myTurn())) return false;
        const value = await readPublished();
        await checkAbsent(i);
        const next = value + 1;
        const text = `config_version: 1\ncounter: ${next}\n# ${"x".repeat(4000)}\n`;
        const tmp = path.join(dir, `.counter.yaml.${side}.${i}.tmp`);
        await publishable(tmp, text);
        await fs.rename(tmp, counter);
        await sql`update drill_counter set value = ${next}, hash = ${sha(text)}, handoffs = handoffs + 1, last_side = ${side}`;
        return true;
      });
      if (!done) await sleep(2);
    }
    result.increments += 1;
  } catch (error) {
    result.errors.push(`increment ${i}: ${error.message}`);
    // let the other side finish its turns instead of waiting for this one for ever
    await sql`update drill_counter set last_side = ''`;
    break;
  }
}

await barrier("links");
for (let round = 0; round < Number(rounds); round += 1) {
  try {
    await withLock(async () => {
      const target = path.join(dir, `round-${round}.yaml`);
      const text = `config_version: 1\nwriter: ${side}\nround: ${round}\n# ${"y".repeat(4000)}\n`;
      const tmp = path.join(dir, `.round-${round}.${side}.tmp`);
      await publishable(tmp, text);
      const rows = await sql`select hash from drill_round where round = ${round}`;
      try {
        await fs.link(tmp, target);
        if (rows.length > 0) throw new Error(`round ${round}: link succeeded over the other side's file`);
        await sql`insert into drill_round (round, hash) values (${round}, ${sha(text)})`;
        result.won += 1;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (rows.length === 0) throw new Error(`round ${round}: EEXIST with no file published`);
        const seen = await read(target);
        if (sha(seen) !== rows[0].hash) throw new Error(`round ${round}: read something other than the published file`);
        result.lost += 1;
      } finally {
        await fs.unlink(tmp);
      }
      const links = (await fs.stat(target)).nlink;
      if (links !== 1) throw new Error(`round ${round}: ${links} links after the temp file was removed`);
    });
  } catch (error) {
    result.errors.push(error.message);
  }
}

await fs.writeFile(out, JSON.stringify(result));
await sql.end({ timeout: 2 });
WORKER

password="$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("hex"))')"
cat >"$work/compose.yaml" <<COMPOSE
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: "$password"
    tmpfs:
      - /var/lib/postgresql/data
    ports:
      - "127.0.0.1::5432"
    healthcheck:
      test: ["CMD", "pg_isready", "-q", "-h", "127.0.0.1", "-U", "postgres"]
      interval: 1s
      timeout: 3s
      retries: 60
  worker:
    image: node:22-slim
    profiles: ["worker"]
    network_mode: "service:db"
    user: "$(id -u):$(id -g)"
    working_dir: /drill
    volumes:
      - "$work/config:/drill/config"
      - "$work/worker.mjs:/drill/worker.mjs:ro"
      - "$work/read-user-file.ts:/drill/read-user-file.ts:ro"
      - "$work/out:/drill/out"
      - "$postgres_pkg:/drill/postgres:ro"
    environment:
      side: container
      dir: /drill/config
      url: "postgres://postgres:$password@127.0.0.1:5432/postgres"
      pkg: /drill/postgres
      count: "$count"
      rounds: "$rounds"
      raw: "$raw_read"
      out: /drill/out/container.json
    command: ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "/drill/worker.mjs"]
COMPOSE
psql() { drill_compose exec -T db psql -qAt -U postgres -c "$1"; }
echo "== starting a throw-away Postgres (compose project $project)"
drill_compose up -d --wait db >/dev/null 2>&1 || { echo "the throw-away Postgres did not start" >&2; exit 2; }
port="$(drill_compose port db 5432 | sed 's/.*://')"

first_text="$(printf 'config_version: 1\ncounter: 0\n')"$'\n'
printf '%s' "$first_text" >"$work/config/counter.yaml"
first_hash="$(node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$work/config/counter.yaml")"
psql "create table drill_counter (value int not null, hash text not null, last_side text not null, handoffs int not null); insert into drill_counter values (0, '$first_hash', '', 0); create table drill_round (round int primary key, hash text not null); create table drill_ready (name text not null, side text not null);" >/dev/null

echo "== $count increments and $rounds link rounds from each side, over a bind mount of $work/config ($([[ "$raw_read" == 1 ]] && echo 'plain fs.readFile' || echo "the app's reader"))"
started=$SECONDS
side=host dir="$work/config" url="postgres://postgres:$password@127.0.0.1:$port/postgres" pkg="$postgres_pkg" count="$count" rounds="$rounds" raw="$raw_read" out="$work/out/host.json" node --experimental-strip-types --disable-warning=ExperimentalWarning "$work/worker.mjs" &
host_pid=$!
container_status=0
drill_compose --profile worker run --rm --no-deps worker || container_status=$?
host_status=0
wait "$host_pid" || host_status=$?
host_pid=""
echo "   took $((SECONDS - started))s"

final="$(psql 'select value from drill_counter')"
on_disk="$(sed -n 's/^counter: //p' "$work/config/counter.yaml")"
handoffs="$(psql 'select handoffs from drill_counter')"
rounds_done="$(psql 'select count(*) from drill_round')"
leftovers="$(find "$work/config" -name '*.tmp' | wc -l | tr -d ' ')"

set +e
node - "$work/out/host.json" "$work/out/container.json" "$final" "$on_disk" "$rounds_done" "$leftovers" "$count" "$rounds" "$host_status" "$container_status" "$handoffs" <<'CHECK'
const fs = require("node:fs");
const [hostFile, containerFile, final, onDisk, roundsDone, leftovers, count, rounds, hostStatus, containerStatus, handoffs] = process.argv.slice(2);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const sides = [read(hostFile), read(containerFile)];
const problems = [];
if (hostStatus !== "0" || containerStatus !== "0" || sides.includes(null)) problems.push(`a side failed (host exit ${hostStatus}, container exit ${containerStatus})`);
const total = Number(count) * 2;
if (Number(final) !== total) problems.push(`recorded counter ${final}, expected ${total}`);
if (Number(onDisk) !== total) problems.push(`counter on disk ${onDisk}, expected ${total}`);
if (Number(roundsDone) !== Number(rounds)) problems.push(`${roundsDone} link rounds published, expected ${rounds}`);
if (Number(handoffs) < total) problems.push(`the sides did not take every turn (${handoffs} of ${total}): not everything was tested`);
if (leftovers !== "0") problems.push(`${leftovers} temp files left`);
for (const side of sides.filter(Boolean)) {
  console.log(`${side.side}: ${side.increments} increments, ${side.stale} stale reads (${side.staleOld} old content up to ${side.behindMax} behind, ${side.staleMissing} missing ${side.errorCodes.join(" ")}; ), ${side.gaps} gaps covered by the reader (longest ${side.gapMsMax} ms), links won ${side.won} / lost ${side.lost}, ${side.errors.length} errors`);
  if (side.stale > 0) problems.push(`${side.side} read ${side.stale} stale files`);
  for (const error of side.errors.slice(0, 5)) problems.push(`${side.side}: ${error}`);
}
const won = sides.filter(Boolean).reduce((sum, side) => sum + side.won, 0);
const lost = sides.filter(Boolean).reduce((sum, side) => sum + side.lost, 0);
if (won !== Number(rounds) || lost !== Number(rounds)) problems.push(`links: ${won} won and ${lost} lost, expected ${rounds} each`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log(`PASS: counter ${final} with ${handoffs} turns, every read returned the published text, every link round had one winner and one EEXIST`);
CHECK
exit $?
