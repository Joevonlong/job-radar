/**
 * `config_version` handling. Every config file may carry a top-level `config_version: <int>` (missing = 1).
 * A file older than the code is migrated in memory on load (and written back by `pnpm config:migrate --write`);
 * a file newer than the code (a downgrade) is refused. The key is handled here, outside the zod schemas: the loader
 * strips it before validation and the writer keeps / stamps it.
 */
import { isMap, isScalar, type Document } from "yaml";

import { ConfigError } from "../errors";
import type { ConfigName } from "../registry";

import { CONFIG_MIGRATIONS } from "./index";
import type { ConfigMigration } from "./types";

export const CONFIG_VERSION_KEY = "config_version";

/** The registered steps of a config, oldest first. */
export function configMigrations(name: ConfigName): readonly ConfigMigration[] {
  return CONFIG_MIGRATIONS[name] ?? [];
}

/** Throws when the steps do not form the chain 1 → 2 → … (a programming error, caught by the tests). */
export function assertMigrationChain(name: string, steps: readonly ConfigMigration[]): void {
  let expected = 1;
  for (const step of steps) {
    if (step.from !== expected || step.to !== step.from + 1) {
      throw new Error(`config migrations of "${name}": expected a step ${expected} → ${expected + 1}, found ${step.from} → ${step.to}`);
    }
    expected = step.to;
  }
}

/** The version this code reads and writes for a config: the `to` of its last migration, 1 without migrations. */
export function currentConfigVersion(name: ConfigName, steps: readonly ConfigMigration[] = configMigrations(name)): number {
  return steps.at(-1)?.to ?? 1;
}

/**
 * The `config_version` of a parsed document: 1 when it is missing, null when it is there but not a positive whole number
 * (or the document is not a mapping, which the schema reports).
 */
export function documentConfigVersion(doc: Document): number | null {
  if (!isMap(doc.contents)) return 1;
  if (!doc.contents.has(CONFIG_VERSION_KEY)) return 1;
  const value: unknown = doc.contents.get(CONFIG_VERSION_KEY);
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * Set `config_version` on a document: in place when the key exists, else as the first key (a comment written above
 * the old first key moves up with it, so a file's header comment stays on top).
 */
export function stampConfigVersion(doc: Document, version: number): void {
  const map = doc.contents;
  if (!isMap(map)) return;
  if (map.has(CONFIG_VERSION_KEY)) {
    const node = map.get(CONFIG_VERSION_KEY, true);
    if (isScalar(node)) node.value = version;
    else map.set(CONFIG_VERSION_KEY, version);
    return;
  }
  const pair = doc.createPair(CONFIG_VERSION_KEY, version);
  const first = map.items[0];
  if (first && isScalar(first.key) && first.key.commentBefore) {
    (pair.key as { commentBefore?: string }).commentBefore = first.key.commentBefore;
    first.key.commentBefore = undefined;
    if (first.key.spaceBefore) {
      first.key.spaceBefore = false;
      (pair.key as { spaceBefore?: boolean }).spaceBefore = true;
    }
  }
  map.items.unshift(pair);
}

/** Drop `config_version` from a parsed value before schema validation (the schemas do not know the key). */
export function withoutConfigVersion(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(CONFIG_VERSION_KEY in value)) return value;
  const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  delete copy[CONFIG_VERSION_KEY];
  return copy;
}

export interface DocumentMigrationResult {
  /** Version the document had. */
  from: number;
  /** Version it has now (the code's current version). */
  to: number;
  /** The steps that ran (empty = it was current already). */
  applied: readonly ConfigMigration[];
}

/**
 * Bring a parsed document up to the code's version, in place. Throws ConfigError when `config_version` is not a positive
 * whole number (`schema`) or is newer than the code supports (`version`: a downgrade, never silently accepted).
 */
export function migrateConfigDocument(name: ConfigName, doc: Document, filePath: string, steps: readonly ConfigMigration[] = configMigrations(name)): DocumentMigrationResult {
  assertMigrationChain(name, steps);
  const from = documentConfigVersion(doc);
  if (from === null) {
    throw new ConfigError({ configName: name, filePath, kind: "schema", issues: [{ path: CONFIG_VERSION_KEY, message: "must be a whole number ≥ 1" }] });
  }
  const current = currentConfigVersion(name, steps);
  if (from > current) {
    throw new ConfigError({
      configName: name,
      filePath,
      kind: "version",
      detail: `config_version ${from} is newer than this version of Job Radar supports (${current}); upgrade Job Radar or restore the file from <user config dir>/.backup`,
    });
  }
  const applied = steps.filter((step) => step.from >= from);
  for (const step of applied) {
    step.migrate(doc);
    stampConfigVersion(doc, step.to);
  }
  return { from, to: current, applied };
}
