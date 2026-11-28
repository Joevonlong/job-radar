import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkNodeEngines } from "../../scripts/ops/check-node-engines.mjs";

const [ref, ...roots] = process.argv.slice(2);
const { engines, packageManager } = JSON.parse(readFileSync(0, "utf8"));
// Early releases used a major-only lower bound, equivalent to the first patch of that major.
const range = engines.node.replace(/^>=(\d+) </, ">=$1.0.0 <");
const failures = [];
for (const root of roots.filter(Boolean)) {
  const bin = path.resolve(root, "bin");
  const node = spawnSync(path.join(bin, "node"), ["--version"], { encoding: "utf8" });
  const version = node.stdout?.trim();
  if (node.status !== 0 || !/^v\d+\.\d+\.\d+$/.test(version) || !checkNodeEngines(range, version).ok) {
    failures.push(`${bin}/node: ${version || "unavailable"}`);
    continue;
  }
  const pnpm = spawnSync(path.join(bin, "pnpm"), ["--version"], {
    cwd: bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8",
  });
  if (pnpm.status !== 0 || `pnpm@${pnpm.stdout.trim()}` !== packageManager.split("+")[0]) {
    failures.push(`${bin}/pnpm: ${pnpm.stdout?.trim() || "unavailable"}`);
    continue;
  }
  console.log(bin);
  process.exit(0);
}
console.error(`transition: ${ref} needs Node ${engines.node} and ${packageManager}. Set JOBRADAR_TRANSITION_NODE22 / JOBRADAR_TRANSITION_NODE26 to their installation directories (bin/node and bin/pnpm). ${failures.join(", ")}`);
process.exitCode = 1;
