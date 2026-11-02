#!/usr/bin/env bash
# Does the config write lock hold across a Docker Desktop bind mount? The writers of one install run in a container and on
# the Mac at the same time, and the lock only works if what one side published is what the other reads once it holds
# the lock. This drill measures that on this machine; it is not part of CI (macOS with Docker only).
#
#   scripts/dev/config-lock-mount-drill.sh [--count N] [--rounds N] [--parent DIR]
#
#   --count N     increments per side (default 500; the total must come out as 2N)
#   --rounds N    link + unlink rounds per side (default 100)
#   --parent DIR  where the temp directory goes; choose the volume the real data lives on (default: the system's temp)
#
# Counter: under a Postgres advisory lock with the key of the config write lock, each side reads the file, compares its
# hash with what the last holder recorded in the database, writes a temp file, fsyncs, renames over the file and records
# the new hash: the same steps as a real commit. Links: each side publishes with link + unlink under the lock; the second
# one must get EEXIST and read the first one's whole file.
#
# It only uses a temp directory and two throw-away containers of its own (`docker run --rm`, removed at the end, also on
# an interrupt): no compose, nothing of an install. Exit 0 = the mount holds, 1 = it does not, 2 = cannot run here.
set -euo pipefail

count=500
rounds=100
parent="${TMPDIR:-/tmp}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) count="${2:-}"; shift 2 ;;
    --rounds) rounds="${2:-}"; shift 2 ;;
    --parent) parent="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$count" =~ ^[1-9][0-9]*$ && "$rounds" =~ ^[1-9][0-9]*$ ]] || { echo "--count and --rounds need a positive whole number" >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo "this drill is for Docker Desktop on macOS" >&2; exit 2; }
command -v docker >/dev/null && docker info >/dev/null 2>&1 || { echo "docker is not running" >&2; exit 2; }
command -v node >/dev/null || { echo "node is not on PATH" >&2; exit 2; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[[ -d "$repo/node_modules/postgres" ]] || { echo "run pnpm install first (the drill uses the postgres package)" >&2; exit 2; }
postgres_pkg="$(cd "$repo/node_modules/postgres" && pwd -P)"
[[ -d "$parent" ]] || { echo "--parent $parent is not a directory" >&2; exit 2; }
work="$(mktemp -d "$(cd "$parent" && pwd -P)/config-lock-drill.XXXXXX")"
db="config-lock-drill-db-$$"
worker="config-lock-drill-worker-$$"
host_pid=""

cleanup() {
  [[ -z "$host_pid" ]] || kill "$host_pid" 2>/dev/null || true
  docker rm -f "$worker" "$db" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

mkdir "$work/config" "$work/out"
cat >"$work/worker.mjs" <<'WORKER'
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";

const { side, dir, url, pkg, count, rounds, out } = process.env;
const { default: postgres } = await import(`${pkg}/src/index.js`);
const sql = postgres(url, { max: 1, onnotice: () => {} });
const KEY = [0x4a52, 0x0003];
const SETTLE_MS = 2000;
const sha = (text) => createHash("sha256").update(text).digest("hex");
const counter = path.join(dir, "counter.yaml");
const result = { side, increments: 0, stale: 0, staleOld: 0, staleMissing: 0, errorCodes: [], behindMax: 0, settleMsMax: 0, won: 0, lost: 0, errors: [] };

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

// What the last holder published, read back until it matches: how long a late one took says what kind of problem it is.
async function readPublished() {
  const [{ value, hash }] = await sql`select value, hash from drill_counter`;
  const started = Date.now();
  let first = true;
  for (;;) {
    const text = await fs.readFile(counter, "utf8").catch((error) => `unreadable: ${error.code}`);
    if (sha(text) === hash) {
      if (!first) result.settleMsMax = Math.max(result.settleMsMax, Date.now() - started);
      return value;
    }
    if (first) {
      result.stale += 1;
      const seen = /^counter: (\d+)$/m.exec(text);
      if (seen === null) {
        result.staleMissing += 1;
        if (!result.errorCodes.includes(text)) result.errorCodes.push(text);
      }
      else {
        result.staleOld += 1;
        result.behindMax = Math.max(result.behindMax, value - Number(seen[1]));
      }
    }
    first = false;
    if (Date.now() - started > SETTLE_MS) throw new Error(`the counter did not match the recorded hash within ${SETTLE_MS} ms (at ${value})`);
    await sleep(10);
  }
}

// Both sides start together: a side that finished before the container came up would prove nothing.
async function barrier(name) {
  await sql`insert into drill_ready (name, side) values (${name}, ${side})`;
  while ((await sql`select count(*)::int as n from drill_ready where name = ${name}`)[0].n < 2) await sleep(5);
}

await barrier("counter");
for (let i = 0; i < Number(count); i += 1) {
  try {
    await withLock(async () => {
      const value = await readPublished();
      const next = value + 1;
      const text = `config_version: 1\ncounter: ${next}\n# ${"x".repeat(4000)}\n`;
      const tmp = path.join(dir, `.counter.yaml.${side}.${i}.tmp`);
      await publishable(tmp, text);
      await fs.rename(tmp, counter);
      await sql`update drill_counter set value = ${next}, hash = ${sha(text)}, handoffs = handoffs + (case when last_side = ${side} then 0 else 1 end), last_side = ${side}`;
    });
    result.increments += 1;
  } catch (error) {
    result.errors.push(`increment ${i}: ${error.message}`);
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
        const seen = await fs.readFile(target, "utf8");
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
echo "== starting a throw-away Postgres ($db)"
docker run --rm -d --name "$db" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$password" postgres:17 >/dev/null
for _ in $(seq 1 120); do
  docker exec "$db" pg_isready -q -h 127.0.0.1 -U postgres && break
  sleep 0.5
done
docker exec "$db" pg_isready -q -h 127.0.0.1 -U postgres || { echo "the throw-away Postgres did not start" >&2; exit 2; }
port="$(docker port "$db" 5432/tcp | head -1 | sed 's/.*://')"

first_text="$(printf 'config_version: 1\ncounter: 0\n')"$'\n'
printf '%s' "$first_text" >"$work/config/counter.yaml"
first_hash="$(node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$work/config/counter.yaml")"
docker exec "$db" psql -q -U postgres -c "create table drill_counter (value int not null, hash text not null, last_side text not null, handoffs int not null); insert into drill_counter values (0, '$first_hash', '', 0); create table drill_round (round int primary key, hash text not null); create table drill_ready (name text not null, side text not null);" >/dev/null

echo "== $count increments and $rounds link rounds from each side, over a bind mount of $work/config"
started=$SECONDS
side=host dir="$work/config" url="postgres://postgres:$password@127.0.0.1:$port/postgres" pkg="$postgres_pkg" count="$count" rounds="$rounds" out="$work/out/host.json" node "$work/worker.mjs" &
host_pid=$!
container_status=0
docker run --rm --name "$worker" --network "container:$db" --user "$(id -u):$(id -g)" \
  -v "$work/config:/drill/config" -v "$work/worker.mjs:/drill/worker.mjs:ro" -v "$work/out:/drill/out" -v "$postgres_pkg:/drill/postgres:ro" \
  -e side=container -e dir=/drill/config -e url="postgres://postgres:$password@127.0.0.1:5432/postgres" -e pkg=/drill/postgres -e count="$count" -e rounds="$rounds" -e out=/drill/out/container.json \
  node:22-slim node /drill/worker.mjs || container_status=$?
host_status=0
wait "$host_pid" || host_status=$?
host_pid=""
echo "   took $((SECONDS - started))s"

final="$(docker exec "$db" psql -qAt -U postgres -c 'select value from drill_counter')"
on_disk="$(sed -n 's/^counter: //p' "$work/config/counter.yaml")"
handoffs="$(docker exec "$db" psql -qAt -U postgres -c 'select handoffs from drill_counter')"
rounds_done="$(docker exec "$db" psql -qAt -U postgres -c 'select count(*) from drill_round')"
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
if (Number(handoffs) < 2) problems.push(`the sides hardly took turns (${handoffs} handoffs): nothing was tested`);
if (leftovers !== "0") problems.push(`${leftovers} temp files left`);
for (const side of sides.filter(Boolean)) {
  console.log(`${side.side}: ${side.increments} increments, ${side.stale} stale reads (${side.staleOld} old content up to ${side.behindMax} behind, ${side.staleMissing} missing ${side.errorCodes.join(" ")}; slowest to settle ${side.settleMsMax} ms), links won ${side.won} / lost ${side.lost}, ${side.errors.length} errors`);
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
console.log(`PASS: counter ${final} with ${handoffs} handoffs between the sides, no stale read, every link round had one winner and one EEXIST`);
CHECK
exit $?
