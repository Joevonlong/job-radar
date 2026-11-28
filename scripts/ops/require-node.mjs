// Loaded by --import before tsx so host commands can diagnose an unsupported Node at startup.
import { readFileSync, writeSync } from "node:fs";

import { checkNodeEngines } from "./check-node-engines.mjs";

export function nodeRequirementError(range, version) {
  const result = checkNodeEngines(range, version);
  if (result.ok) return null;
  if (result.reason !== "out-of-range") return result.message;
  return `Job Radar needs Node ${result.min.join(".")} or a later ${result.min[0]}.x (engines.node "${range}"); this is Node ${version}. Install it, then retry.`;
}

let error;
try {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  error = nodeRequirementError(pkg?.engines?.node, process.versions.node);
} catch {
  error = "Job Radar could not read its package.json to check engines.node.";
}
if (error) {
  writeSync(2, `${error}\n`);
  process.exit(1);
}
