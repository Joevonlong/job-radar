/**
 * Print validated config values for shell scripts (`cfg_get` in scripts/ops/lib/config.sh; backup.sh, restore.sh).
 *
 *   node --import <tsx loader> scripts/config-get.ts <file> <path>...
 *
 * <file> is a config file name (`schedule.yaml`) or its config name (`schedule`); each <path> is a dotted key path into
 * the effective value, as the loader reads it (user file over the shipped default, migrated in memory, validated, zod
 * defaults filled in). Prints one line per path: a one-line string as it is, anything else as JSON.
 *
 * Exit codes: 0 every value printed; 1 the config is invalid (the error names the file and the field); 2 usage (an
 * unknown file); 3 a path is not in the effective value. Nothing is printed on stdout unless every path resolves, so a
 * caller never reads half an answer. Honours JOB_RADAR_DEFAULTS_DIR / JOB_RADAR_CONFIG_DIR / JOB_RADAR_PROFILE_DIR.
 */
import { CONFIG_NAMES, configRegistry, parseConfigText, readConfigText, type ConfigName } from "../src/lib/config";

function usage(message: string): never {
  console.error(`config-get: ${message}\nusage: config-get.ts <file> <path>...  (for example: config-get.ts schedule.yaml timezone backup.max_age_hours)`);
  process.exit(2);
}

function configName(arg: string): ConfigName {
  const name = CONFIG_NAMES.find((candidate) => candidate === arg || configRegistry[candidate].file === arg);
  if (name === undefined) usage(`unknown config file '${arg}'`);
  return name;
}

function lookup(value: unknown, keyPath: string): { found: true; value: unknown } | { found: false } {
  let current: unknown = value;
  for (const key of keyPath.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, key)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? { found: false } : { found: true, value: current };
}

const [fileArg, ...paths] = process.argv.slice(2);
if (fileArg === undefined || paths.length === 0) usage("a file and at least one path are needed");
const name = configName(fileArg);

let value: unknown;
try {
  value = parseConfigText(name, readConfigText(name));
} catch (err) {
  console.error(`config-get: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const lines: string[] = [];
for (const keyPath of paths) {
  const result = lookup(value, keyPath);
  if (!result.found) {
    console.error(`config-get: ${configRegistry[name].file} has no ${keyPath}`);
    process.exit(3);
  }
  lines.push(typeof result.value === "string" && !result.value.includes("\n") ? result.value : JSON.stringify(result.value));
}
process.stdout.write(`${lines.join("\n")}\n`);
