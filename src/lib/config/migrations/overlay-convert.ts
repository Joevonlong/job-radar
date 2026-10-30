/**
 * Turn a legacy full-copy config file into an overlay with the same effective value (not used by the loader yet).
 *
 * Invariant (tested over the golden inputs): zod(mergeLayers(shipped, overlay)) deep-equals zod(legacy). Both values are
 * migrated and carry no `config_version`. How each key ends up:
 * - equal to the shipped value → left out, it follows the shipped default from now on (`dropped`, for the conversion
 *   report: a hand-written pin equal to the shipped value is not kept);
 * - different → kept in the overlay (`kept`);
 * - missing from the legacy file while the shipped file has it: left out when the effective value does not change (the
 *   schema default equals the shipped value); written as the explicit value the legacy file effectively had
 *   (`filled`: a schema default that differs from the shipped value); `key: !unset` when there is no such value (an
 *   entry the user deleted, such as a glossary term) (`unset`).
 *
 * A legacy file that does not pass its schema is not converted: it throws ConfigError(schema).
 */
import { ConfigError, zodIssues } from "../errors";
import { isPlainMap, mergeLayers, plainEqual, valueAt } from "../merge";
import { applyOverlayEdits, repairOverlayEdits, type OverlayEdit } from "../overlay-diff";
import { formatKeyPath, replaceRule, type KeyPath, type ReplaceAt } from "../overlay-rules";
import { configRegistry, type ConfigName } from "../registry";

export interface ConvertLegacyInput {
  /** The shipped value (migrated, without `config_version`). */
  shipped: unknown;
  /** The legacy full file's value (migrated, without `config_version`). */
  legacy: unknown;
  /** For error messages. */
  filePath: string;
}

export interface ConvertLegacyResult {
  /** Applied to an empty overlay (`applyOverlayEdits({}, edits)`), they give the converted overlay. */
  edits: OverlayEdit[];
  dropped: string[];
  kept: string[];
  filled: string[];
  unset: string[];
}

function collectDropped(shipped: unknown, legacy: unknown, path: string[], replaceAt: ReplaceAt, out: KeyPath[]): void {
  if (isPlainMap(shipped) && isPlainMap(legacy) && !replaceAt(path)) {
    for (const key of Object.keys(legacy)) if (Object.hasOwn(shipped, key)) collectDropped(shipped[key], legacy[key], [...path, key], replaceAt, out);
    return;
  }
  if (path.length > 0 && plainEqual(shipped, legacy)) out.push(path);
}

export function convertLegacy(name: ConfigName, input: ConvertLegacyInput): ConvertLegacyResult {
  const schema = configRegistry[name].schema;
  const replaceAt = replaceRule(name);
  const legacyResult = schema.safeParse(input.legacy);
  if (!legacyResult.success) throw new ConfigError({ configName: name, filePath: input.filePath, kind: "schema", issues: zodIssues(legacyResult.error) });
  const expected: unknown = legacyResult.data;
  const verifies = (edits: readonly OverlayEdit[]): boolean => {
    const result = schema.safeParse(mergeLayers(input.shipped, applyOverlayEdits({}, edits), { replaceAt }));
    return result.success && plainEqual(result.data, expected);
  };

  // exact at the raw level (so it verifies), then each `!unset` is replaced by something that follows the shipped file
  let edits = repairOverlayEdits(input.shipped, input.legacy, replaceAt);
  const filled: KeyPath[] = [];
  for (const edit of [...edits]) {
    if (edit.op !== "unset") continue;
    const index = edits.indexOf(edit);
    const without = edits.filter((_, i) => i !== index);
    if (verifies(without)) {
      edits = without;
      continue;
    }
    const effective = valueAt(expected, edit.path);
    if (effective === undefined) continue;
    const explicit: OverlayEdit[] = edits.map((other, i) => (i === index ? { op: "set", path: edit.path, value: structuredClone(effective) } : other));
    if (verifies(explicit)) {
      edits = explicit;
      filled.push(edit.path);
    }
  }
  if (!verifies(edits)) throw new Error(`converting ${configRegistry[name].file} to an overlay would change its effective value`);

  const dropped: KeyPath[] = [];
  collectDropped(input.shipped, input.legacy, [], replaceAt, dropped);
  const filledKeys = new Set(filled.map(formatKeyPath));
  const kept = edits.filter((edit) => edit.op === "set").map((edit) => formatKeyPath(edit.path)).filter((path) => !filledKeys.has(path));
  return {
    edits,
    dropped: dropped.map(formatKeyPath),
    kept,
    filled: [...filledKeys],
    unset: edits.filter((edit) => edit.op === "unset").map((edit) => formatKeyPath(edit.path)),
  };
}
