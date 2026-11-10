#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/career-print-baseline-linux.sh <output-directory>" >&2
  exit 2
fi
baseline="$(cd tests/fixtures/career/print-baseline && pwd -P)"
output="$(node --input-type=module - "$1" "$baseline" <<'NODE'
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
function canonical(file) {
  return existsSync(file) ? realpathSync(file) : path.join(canonical(path.dirname(file)), path.basename(file));
}
const output = canonical(path.resolve(process.argv[2]));
const relative = path.relative(process.argv[3], output);
if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
  console.error("Output must not be inside the print baseline directory");
  process.exit(2);
}
console.log(output);
NODE
)"
mkdir -p "$output"
bundle="$(mktemp -d)"
container=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null; fi
  rm -rf "$bundle"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker build --target runner -t job-radar-print-baseline:local .
pnpm exec esbuild career-print-baseline=scripts/career-print-baseline.ts --bundle --external:playwright-core --platform=node --format=esm --target=node22 --outdir="$bundle" --out-extension:.js=.mjs --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
container="$(docker create --network none --entrypoint node job-radar-print-baseline:local /app/dist/career-print-baseline.mjs --fixtures /app/print-fixtures --out /tmp/print-output)"
docker cp "$bundle/career-print-baseline.mjs" "$container:/app/dist/career-print-baseline.mjs"
docker cp tests/fixtures/career "$container:/app/print-fixtures"
status=0
docker start -a "$container" || status=$?
docker cp "$container:/tmp/print-output/." "$output/"
exit "$status"
