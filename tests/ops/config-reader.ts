/**
 * The config readers of the ops scripts (scripts/ops/lib/config.sh) in a throw-away checkout, with a fake `node`.
 *
 * `cfg_get` runs `node --import <checkout>/node_modules/tsx/dist/loader.mjs <checkout>/scripts/config-get.ts <file> <path>...`.
 * The fake node stands in for the app's loader: it records the call in $STUB_NODE_LOG, fails when $STUB_NODE_EXIT is set
 * (an invalid config, a broken install), and otherwise answers each path the way the loader would for the simple files
 * these tests write: the value from the user file (else the shipped one), else the zod default of the key. It reads them
 * with the shell reader without the zone database check, so a zone this system does not know still comes through, as it
 * does from the real loader on a system with full ICU data.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "../..");
export const REAL_CONFIG_LIB = path.join(REPO, "scripts/ops/lib/config.sh");

const FAKE_NODE = `#!/usr/bin/env bash
# fake node: config-get.ts in front of the shell reader (tests/ops/config-reader.ts)
[[ -z "\${STUB_NODE_LOG:-}" ]] || echo "node $*" >> "$STUB_NODE_LOG"
[[ -z "\${STUB_NODE_EXIT:-}" ]] || { echo "config-get: schedule.yaml: invalid (stub)" >&2; exit "$STUB_NODE_EXIT"; }
[[ "$1" == --import ]] || { echo "fake node: unexpected arguments: $*" >&2; exit 64; }
script="$3"; file="$4"; shift 4
source "$(dirname "$script")/ops/lib/config.sh"
export JOB_RADAR_ZONEINFO_DIR=/nonexistent-zoneinfo
out=""
for key in "$@"; do
  case "$key" in
    timezone) value="$(cfg_identity "$file" timezone timezone)" || exit 1 ;;
    backup.max_age_hours) value="$(cfg_identity "$file" "$key" positive_int 30)" || exit 1 ;;
    backup.keep_old_databases) value="$(cfg_identity "$file" "$key" positive_int 1)" || exit 1 ;;
    doctor.compose_project) value="$(cfg_identity "$file" "$key" compose_project job-radar)" || exit 1 ;;
    *) echo "fake node: no fake for $key" >&2; exit 3 ;;
  esac
  out="$out$value"$'\\n'
done
printf '%s' "$out"
`;

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

/** Put lib/config.sh, an empty tsx loader and an (unused) config-get.ts into the checkout, and the fake `node` into `stubs`. */
export function installConfigReader(checkout: string, stubs: string): void {
  write(path.join(checkout, "scripts/ops/lib/config.sh"), fs.readFileSync(REAL_CONFIG_LIB, "utf8"));
  write(path.join(checkout, "node_modules/tsx/dist/loader.mjs"), "");
  write(path.join(checkout, "scripts/config-get.ts"), "// run by the fake node only\n");
  write(path.join(stubs, "node"), FAKE_NODE, 0o755);
}

/** The checkout without the tsx loader, as before `pnpm install`. */
export function removeTsxLoader(checkout: string): void {
  fs.rmSync(path.join(checkout, "node_modules"), { recursive: true, force: true });
}

/**
 * A PATH without any `node`: every directory of `base` that has one is left out, and the tools the scripts need are
 * reached through `linkDir` (symbolic links to the real ones). For the "no node installed" cases.
 */
export function pathWithoutNode(base: string, linkDir: string, tools: readonly string[]): string {
  fs.mkdirSync(linkDir, { recursive: true });
  const dirs = base.split(":").filter(Boolean);
  for (const tool of tools) {
    const target = path.join(linkDir, tool);
    if (fs.existsSync(target)) continue;
    const found = dirs.map((dir) => path.join(dir, tool)).find((candidate) => fs.existsSync(candidate));
    if (found) fs.symlinkSync(found, target);
  }
  return [linkDir, ...dirs.filter((dir) => !fs.existsSync(path.join(dir, "node")))].join(":");
}
