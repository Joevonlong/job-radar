/**
 * The default-value change list for a release: which shipped config values (`config/*.yaml`, migrated to the code's
 * format, as the loader reads them) differ between two git refs. A key a user has not overridden changes on every
 * installation when the release goes out, so the list is read before tagging.
 *
 * Keys the web may not edit (protected: program names, API hosts, credential files, data exits) are listed in their own
 * section with no values: review them by hand. A key that is new in a protected path is a new way for data to leave the
 * machine: it must ship switched off.
 *
 * Usage: pnpm release:changed-defaults <from-ref> <to-ref> [--json]
 *
 * Reads the two refs with `git show`; changes nothing. Market packs (`config/markets/`) are not compared: diff them in git.
 */
import { execFileSync } from "node:child_process";

import { changedDefaults, type ChangedDefault } from "../../src/lib/config/overlay-report";
import { shippedEffective } from "../../src/lib/config/load";
import { configRegistry, LAYERED_CONFIG_NAMES, type ConfigName } from "../../src/lib/config/registry";

const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const asJson = process.argv.includes("--json");
const [from, to] = args;
if (from === undefined || to === undefined || args.length !== 2) {
  console.error("Usage: pnpm release:changed-defaults <from-ref> <to-ref> [--json]");
  process.exit(2);
}

for (const ref of [from, to]) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { stdio: "ignore" });
  } catch {
    console.error(`Not a git commit: ${ref}`);
    process.exit(2);
  }
}

/** The text of `config/<file>` at a ref; null when the ref has no such path. Any other `git show` failure is thrown. */
function fileAt(ref: string, file: string): string | null {
  const spec = `${ref}:config/${file}`;
  try {
    // the ref was verified above and is passed after --end-of-options, so it can never be read as an option
    return execFileSync("git", ["show", "--end-of-options", spec], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/exists on disk, but not in|does not exist in|path .* does not exist|Not a valid object name .*:config/i.test(stderr)) return null;
    throw new Error(`git show ${spec} failed: ${stderr.split("\n")[0] || (err instanceof Error ? err.message : String(err))}`);
  }
}

function valueAt(name: ConfigName, ref: string): unknown {
  const file = configRegistry[name].file;
  const text = fileAt(ref, file);
  return text === null ? undefined : shippedEffective(name, text, `${ref}:config/${file}`).value;
}

interface FileChanges {
  name: ConfigName;
  file: string;
  /** The whole file exists on one side only. */
  fileChange: "added" | "removed" | null;
  changes: ChangedDefault[];
}

const results: FileChanges[] = [];
try {
  for (const name of LAYERED_CONFIG_NAMES) {
    const before = valueAt(name, from);
    const after = valueAt(name, to);
    if (before === undefined && after === undefined) continue;
    const fileChange = before === undefined ? "added" : after === undefined ? "removed" : null;
    const changes = changedDefaults(name, before ?? {}, after ?? {});
    if (changes.length > 0 || fileChange !== null) results.push({ name, file: configRegistry[name].file, fileChange, changes });
  }
} catch (err) {
  console.error(`Cannot compare ${from} and ${to}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify({ from, to, files: results }, null, 2));
  process.exit(0);
}

const text = (value: unknown): string => JSON.stringify(value) ?? String(value);
const show = (change: ChangedDefault): string => {
  if (change.summary !== null && change.change === "changed") return `~ ${change.path}: ${change.summary}`;
  if (change.change === "added") return `+ ${change.path} = ${text(change.after)}`;
  if (change.change === "removed") return `- ${change.path} (was ${text(change.before)})`;
  return `~ ${change.path}: ${text(change.before)} -> ${text(change.after)}`;
};

console.log(`Shipped default changes ${from} -> ${to}\n`);
const plain = results.map((file) => ({ ...file, changes: file.changes.filter((change) => !change.protected) })).filter((file) => file.changes.length > 0 || file.fileChange !== null);
if (plain.length === 0) console.log("(none)");
for (const file of plain) {
  console.log(`${file.file}${file.fileChange === null ? "" : ` (${file.fileChange})`}`);
  for (const change of file.changes) console.log(`  ${show(change)}`);
}
const protectedChanges = results.flatMap((file) => file.changes.filter((change) => change.protected).map((change) => ({ file: file.file, change })));
console.log(`\nProtected keys (values not shown; review by hand)${protectedChanges.length === 0 ? ": none" : ""}`);
for (const { file, change } of protectedChanges) console.log(`  ${file}  ${change.change === "added" ? "+" : change.change === "removed" ? "-" : "~"} ${change.path}`);
