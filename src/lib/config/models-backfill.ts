/**
 * models.yaml is a `shipped` file: a user copy replaces it as a whole. A copy made before a provider existed has no section
 * for it, which would fail the schema (every provider needs one) and leave the new provider without priced models. So a
 * provider section the copy lacks entirely is taken from the shipped file; sections the copy has are never touched (the
 * model-level merge is a separate step).
 */
import fs from "node:fs";

import { AI_PROVIDER_IDS } from "./ai-options";
import { getDefaultConfigPath } from "./paths";
import { parseConfigYamlDocument } from "./yaml-options";

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `providers` map of the shipped models.yaml, or null when it cannot be read (the schema then reports what is missing). */
function shippedProviders(): Record<string, unknown> | null {
  const file = getDefaultConfigPath("models");
  if (file === null) return null;
  try {
    const doc = parseConfigYamlDocument(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    if (doc.errors.length > 0) return null;
    const value: unknown = doc.toJS();
    return isPlainObject(value) && isPlainObject(value.providers) ? value.providers : null;
  } catch {
    return null;
  }
}

/**
 * The plain value of a models.yaml with every provider section it lacks filled in from the shipped file. Anything that is
 * not a mapping with a `providers` mapping is returned as it is, for the schema to report. Never changes `raw`.
 */
export function withShippedModelProviders(raw: unknown): unknown {
  if (!isPlainObject(raw) || !isPlainObject(raw.providers)) return raw;
  const own = raw.providers;
  const missing = AI_PROVIDER_IDS.filter((id) => !Object.hasOwn(own, id));
  if (missing.length === 0) return raw;
  const shipped = shippedProviders();
  if (shipped === null) return raw;
  const providers: Record<string, unknown> = { ...own };
  for (const id of missing) if (Object.hasOwn(shipped, id)) providers[id] = shipped[id];
  return { ...raw, providers };
}
