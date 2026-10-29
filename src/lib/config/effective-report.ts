/**
 * The effective value of every config, as `pnpm config:check --effective` reports it: per file, where it is read from
 * and the canonical hash of what the loader makes of it (`canonical-hash.ts`). The golden tests run this same code over
 * fixed inputs, on this checkout and on an older one (`scripts/dev/gen-config-golden.ts` copies this file there), so it
 * only uses loader functions that older versions have too.
 */
import { canonicalConfigHash } from "./canonical-hash";
import { configSourcePath, parseConfigText, readConfigText } from "./load";
import { configLayer } from "./paths";
import { CONFIG_NAMES, configRegistry, type ConfigName } from "./registry";

export interface EffectiveEntry {
  name: ConfigName;
  file: string;
  /** `user` / `default`; `missing` only for a profile file that does not exist (skipped). */
  layer: "user" | "default" | "missing";
  /** Canonical hash of the validated value; null when it is missing or invalid. */
  hash: string | null;
  /** The first line of the error (names the file and the field, never the contents); null when it loads. */
  error: string | null;
  /** The validated value, for the golden files. */
  value: unknown;
}

export function effectiveConfigEntries(names: readonly ConfigName[] = CONFIG_NAMES): EffectiveEntry[] {
  return names.map((name): EffectiveEntry => {
    const layer = configLayer(name);
    const file = configSourcePath(name);
    if (layer === "missing" && configRegistry[name].location === "profile") return { name, file, layer, hash: null, error: null, value: null };
    try {
      const value = parseConfigText(name, readConfigText(name), file);
      return { name, file, layer: layer === "missing" ? "user" : layer, hash: canonicalConfigHash(value), error: null, value };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { name, file, layer: layer === "missing" ? "user" : layer, hash: null, error: message.split("\n")[0] ?? message, value: null };
    }
  });
}
