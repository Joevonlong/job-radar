/**
 * The canonical hash of an effective config value (the zod output): SHA-256 of its canonical JSON. Key order, comments
 * and `config_version` do not change it; any leaf value does. `pnpm config:check --effective` prints it, and the golden
 * tests compare it across versions of the loader.
 *
 * Self-contained on purpose (only `node:crypto`): `scripts/dev/gen-config-golden.ts` copies it onto an older checkout.
 */
import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonical(item)));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = canonical(child);
    }
    return out;
  }
  return value;
}

/** JSON with every mapping's keys sorted and the top-level `config_version` left out. */
export function canonicalConfigJson(value: unknown): string {
  let root = value;
  if (typeof root === "object" && root !== null && !Array.isArray(root) && "config_version" in root) {
    const copy: Record<string, unknown> = { ...(root as Record<string, unknown>) };
    delete copy.config_version;
    root = copy;
  }
  return JSON.stringify(canonical(root)) ?? "null";
}

export function canonicalConfigHash(value: unknown): string {
  return createHash("sha256").update(canonicalConfigJson(value), "utf8").digest("hex");
}
