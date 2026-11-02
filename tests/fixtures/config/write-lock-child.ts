/**
 * One config writer in a process of its own, for tests/integration/config/write-lock-*.test.ts:
 * `node --import tsx tests/fixtures/config/write-lock-child.ts '<action as JSON>'`. Uses the real database lock (nothing
 * replaces the provider here) and stops where `JOB_RADAR_TEST_LOCK_PAUSE` says. Prints one JSON line: what happened.
 */
import { ConfigError, loadConfig, writeConfig, writeConfigText, type ConfigName, type ConfigValue } from "../../../src/lib/config";

type Action =
  /** A form save: the file's current value with `patch` on top, refused when the file is not `baseHash` any more. */
  | { op: "save"; name: ConfigName; patch: Record<string, unknown>; baseHash?: string }
  /** An advanced editor save. */
  | { op: "edit"; name: ConfigName; text: string; baseHash: string; baseLayer: "user" | "default" };

const action = JSON.parse(process.argv[2] ?? "{}") as Action;

async function run(): Promise<void> {
  if (action.op === "save") {
    const value = { ...loadConfig(action.name), ...action.patch } as ConfigValue<ConfigName>;
    await writeConfig(action.name, value, action.baseHash === undefined ? {} : { baseHash: action.baseHash });
  } else {
    await writeConfigText(action.name, action.text, { baseHash: action.baseHash, baseLayer: action.baseLayer, maxBytes: 1_000_000, backupsKeep: 5 });
  }
}

try {
  await run();
  console.log(JSON.stringify({ status: "saved" }));
  process.exit(0);
} catch (error) {
  if (error instanceof ConfigError) {
    console.log(JSON.stringify({ status: "error", kind: error.kind, detail: error.detail ?? null }));
    process.exit(0);
  }
  console.error(error);
  process.exit(3);
}
