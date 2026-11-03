/**
 * models.yaml is `shipped` and the user's file is an overlay on it: the effective catalog is the shipped catalog with
 * the user's models laid over it, provider by provider and model by model (by `id`).
 *
 * - a user entry replaces the shipped entry with the same `id` as a whole (no field-level merge: no half of an old
 *   price); a new `id` follows the shipped entries;
 * - a user entry with `deprecated: true` and no price only hides the shipped model: it keeps the shipped fields;
 * - any `cli_default: true` in the user layer disables the shipped `cli_default`;
 * - a shipped model id wins over a user alias with the same name (the alias is dropped, a warning); a user id or alias
 *   that equals a shipped alias takes it over (the shipped alias is dropped). Clashes inside the user layer are errors;
 * - a provider section the user file lacks is the shipped one (a whole copy made before a provider existed keeps loading).
 *
 * Pure apart from reading the shipped file; it holds paths and reasons only, never values (C4).
 */
import fs from "node:fs";

import { AI_PROVIDER_IDS, type AiProviderIdChoice } from "./ai-options";
import type { ConfigIssue } from "./errors";
import { getDefaultConfigPath, getUserConfigPath } from "./paths";
import { readUserText } from "./read-user-file";
import { modelsOverlaySchema } from "./schemas/models";
import { parseConfigYamlDocument } from "./yaml-options";

type PlainMap = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainMap => typeof value === "object" && value !== null && !Array.isArray(value);

/** Where in the user's file (`providers.openrouter.models[2].aliases[0]`) and why. */
export interface OverlayIssue {
  path: (string | number)[];
  message: string;
}

export interface ModelsMerge {
  /** The effective catalog as a plain value for `modelsSchema`. */
  value: unknown;
  /** Make the file invalid. */
  errors: OverlayIssue[];
  /** Worth knowing, not wrong: a dropped alias. */
  warnings: OverlayIssue[];
}

/**
 * Problems found in the merged catalog name its positions (`providers.openrouter.models[7].price`), which are not the ones in
 * the user's file. Each one is moved to the model's position in the user's file (matched by id); a model only the shipped file
 * has is named by its id, with a note that it is not in the user's file.
 */
export function issuesInUserFile(issues: readonly ConfigIssue[], merged: unknown, user: unknown): ConfigIssue[] {
  return issues.map((issue) => {
    const hit = /^providers\.([^.[\]]+)\.models\[(\d+)\](.*)$/.exec(issue.path);
    if (!hit || !isPlainObject(merged) || !isPlainObject(merged.providers)) return issue;
    const [, provider = "", mergedIndex = "", rest = ""] = hit;
    const id = idOf(modelsOf(merged.providers[provider])[Number(mergedIndex)] ?? {});
    if (id === "") return issue;
    const userIndex = isPlainObject(user) && isPlainObject(user.providers) ? modelsOf(user.providers[provider]).findIndex((model) => idOf(model) === id) : -1;
    if (userIndex >= 0) return { path: `providers.${provider}.models[${userIndex}]${rest}`, message: issue.message };
    return { path: `providers.${provider}.models[id=${id}]${rest}`, message: `${issue.message} (shipped model, not listed in your file)` };
  });
}

/** The plain value of the shipped models.yaml, or null when it cannot be read (the schema then reports what is missing). */
export function readShippedModels(): PlainMap | null {
  const file = getDefaultConfigPath("models");
  if (file === null) return null;
  try {
    const doc = parseConfigYamlDocument(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    if (doc.errors.length > 0) return null;
    const value: unknown = doc.toJS();
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

const modelsOf = (section: unknown): PlainMap[] => (isPlainObject(section) && Array.isArray(section.models) ? section.models.filter(isPlainObject) : []);
const idOf = (model: PlainMap): string => (typeof model.id === "string" ? model.id : "");
const aliasesOf = (model: PlainMap): string[] => (Array.isArray(model.aliases) ? model.aliases.filter((a): a is string => typeof a === "string") : []);

function mergeProvider(provider: AiProviderIdChoice, shippedSection: unknown, userSection: unknown, issues: { errors: OverlayIssue[]; warnings: OverlayIssue[] }): unknown {
  if (!isPlainObject(userSection)) return shippedSection ?? userSection;
  const shippedMap = isPlainObject(shippedSection) ? shippedSection : {};
  const shippedModels = modelsOf(shippedSection);
  const userModels = modelsOf(userSection);
  const at = (index: number, ...rest: (string | number)[]): (string | number)[] => ["providers", provider, "models", index, ...rest];

  // the user layer on its own: unique ids, aliases that clash with nothing in it
  const userIds = new Set<string>();
  userModels.forEach((model, index) => {
    const id = idOf(model);
    if (userIds.has(id)) issues.errors.push({ path: at(index, "id"), message: `duplicate model id "${id}"` });
    userIds.add(id);
  });
  const userAliases = new Set<string>();
  userModels.forEach((model, index) => {
    aliasesOf(model).forEach((alias, j) => {
      if (userIds.has(alias) || userAliases.has(alias)) issues.errors.push({ path: at(index, "aliases", j), message: `alias "${alias}" clashes with another model id or alias` });
      userAliases.add(alias);
    });
  });
  if (provider === "codex-cli" && userModels.filter((m) => m.cli_default === true).length > 1) {
    const second = userModels.map((m, i) => (m.cli_default === true ? i : -1)).filter((i) => i >= 0)[1] ?? 0;
    issues.errors.push({ path: at(second, "cli_default"), message: "only one model can be the CLI default" });
  }

  const userHasCliDefault = userModels.some((m) => m.cli_default === true);
  const shippedIds = new Set(shippedModels.map(idOf));
  const userNames = new Set([...userIds, ...userAliases]);

  // a shipped model id outranks a user alias of the same name
  const userKept = userModels.map((model, index) => {
    const aliases = aliasesOf(model);
    const kept = aliases.filter((alias, j) => {
      if (!shippedIds.has(alias) || userIds.has(alias)) return true;
      issues.warnings.push({ path: at(index, "aliases", j), message: `alias "${alias}" is the id of a shipped model: the shipped model wins, the alias is ignored` });
      return false;
    });
    if (kept.length === aliases.length) return model;
    const rest = Object.fromEntries(Object.entries(model).filter(([key]) => key !== "aliases"));
    return kept.length > 0 ? { ...rest, aliases: kept } : rest;
  });
  const userKeptById = new Map(userKept.map((model) => [idOf(model), model]));

  const merged: PlainMap[] = shippedModels.map((shipped) => {
    const user = userKeptById.get(idOf(shipped));
    if (user !== undefined) {
      const hides = user.deprecated === true && user.price === undefined && user.equivalent_price === undefined;
      const entry: PlainMap = hides ? { ...shipped, ...user } : { ...user };
      if (hides && userHasCliDefault && user.cli_default !== true) delete entry.cli_default;
      if (hides) {
        // the shipped aliases it keeps give way to the user's other ids and aliases, as an untouched shipped model's do
        const kept = aliasesOf(entry).filter((alias) => !userNames.has(alias) || aliasesOf(user).includes(alias));
        if (kept.length !== aliasesOf(entry).length) {
          if (kept.length > 0) entry.aliases = kept;
          else delete entry.aliases;
        }
      }
      return entry;
    }
    // a shipped model the user did not touch: it gives way to the user's ids and aliases (aliases), and to a user cli_default
    const entry: PlainMap = { ...shipped };
    if (userHasCliDefault) delete entry.cli_default;
    const aliases = aliasesOf(shipped).filter((alias) => !userNames.has(alias));
    if (aliases.length !== aliasesOf(shipped).length) {
      if (aliases.length > 0) entry.aliases = aliases;
      else delete entry.aliases;
    }
    return entry;
  });
  for (const user of userKept) if (!shippedIds.has(idOf(user))) merged.push(user);

  const out: PlainMap = { ...shippedMap };
  for (const key of ["label", "docs_url", "notes"] as const) if (userSection[key] !== undefined) out[key] = userSection[key];
  out.models = merged;
  return out;
}

/**
 * The effective catalog from the shipped file's plain value and the user file's (without `config_version`). `user` that
 * is not a mapping with a `providers` mapping is returned as it is, for the schema to report. Never changes its inputs.
 */
export function mergeModelsOverlay(shipped: unknown, user: unknown): ModelsMerge {
  const errors: OverlayIssue[] = [];
  const warnings: OverlayIssue[] = [];
  if (!isPlainObject(user) || !isPlainObject(user.providers) || !isPlainObject(shipped) || !isPlainObject(shipped.providers)) return { value: user, errors, warnings };
  const parsed = modelsOverlaySchema.safeParse(user);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const base = issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment)));
      if (issue.code === "unrecognized_keys") for (const key of issue.keys) errors.push({ path: [...base, key], message: "unknown key" });
      else errors.push({ path: base, message: issue.message });
    }
    return { value: user, errors, warnings };
  }
  const providers: PlainMap = {};
  for (const id of AI_PROVIDER_IDS) {
    const section = mergeProvider(id, shipped.providers[id], user.providers[id], { errors, warnings });
    if (section !== undefined) providers[id] = section;
  }
  return { value: { ...user, providers }, errors, warnings };
}

/** `mergeModelsOverlay` over the shipped file on disk (a shipped file that cannot be read leaves the user value as it is). */
export function mergeModelsWithShipped(user: unknown): ModelsMerge {
  const shipped = readShippedModels();
  return shipped === null ? { value: user, errors: [], warnings: [] } : mergeModelsOverlay(shipped, user);
}

/** Whether the user's file lists a model the shipped catalog already has, unchanged: a full copy that could be slimmed down. */
export function overlayRedundancy(shipped: unknown, user: unknown): { redundant: number; total: number } {
  if (!isPlainObject(shipped) || !isPlainObject(shipped.providers) || !isPlainObject(user) || !isPlainObject(user.providers)) return { redundant: 0, total: 0 };
  let redundant = 0;
  let total = 0;
  for (const id of AI_PROVIDER_IDS) {
    const shippedById = new Map(modelsOf(shipped.providers[id]).map((m) => [idOf(m), m]));
    for (const model of modelsOf(user.providers[id])) {
      total += 1;
      const same = shippedById.get(idOf(model));
      if (same !== undefined && JSON.stringify(sortKeys(same)) === JSON.stringify(sortKeys(model))) redundant += 1;
    }
  }
  return { redundant, total };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

export interface OverlayInspection {
  /** Warnings of the merge: aliases that were dropped. */
  warnings: OverlayIssue[];
  /** Models of the user's file identical to the shipped ones (a whole copy lists them all), and how many models it lists. */
  redundant: number;
  total: number;
}

/** What `pnpm config:check` says about the user's models.yaml; null when there is none, or it or the shipped file cannot be read (reported elsewhere). */
export function inspectModelsOverlay(): OverlayInspection | null {
  const shipped = readShippedModels();
  if (shipped === null) return null;
  let user: unknown;
  try {
    const doc = parseConfigYamlDocument(readUserText(getUserConfigPath("models")));
    if (doc.errors.length > 0) return null;
    user = doc.toJS();
  } catch {
    return null;
  }
  if (isPlainObject(user)) delete user.config_version;
  return { warnings: mergeModelsOverlay(shipped, user).warnings, ...overlayRedundancy(shipped, user) };
}
