/**
 * The one way the user's models.yaml (the overlay on the shipped catalog) is written by the app: `pnpm models:sync` and
 * the "add to my list" button of /settings both call `writeModelsOverlay`.
 *
 * Everything happens under the config write lock: the newest user file is read inside it, the chosen entries are put in
 * (a new id is appended, an existing id of the user's file is replaced as a whole), comments and layout are kept, the
 * merged catalog (shipped + overlay) is validated, and only then the file is replaced atomically. Nothing is validated
 * outside the lock and written afterwards.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import { Document, isMap, isSeq, YAMLMap, YAMLSeq } from "yaml";

import type { AiProviderIdChoice } from "./ai-options";
import { backupConfigText } from "./editor-backup";
import { ConfigError, zodIssues } from "./errors";
import { loadConfig, parseConfigDocument, primeConfigCache, reloadConfig, resolveConfigDocument } from "./load";
import { CONFIG_VERSION_KEY, currentConfigVersion, documentConfigVersion, migrateConfigDocument, stampConfigVersion, withoutConfigVersion } from "./migrations/version";
import { issuesInUserFile } from "./models-overlay";
import { getUserConfigPath } from "./paths";
import { readUserText } from "./read-user-file";
import { type CatalogModel, modelsSchema } from "./schemas/models";
import { CONFIG_EDITOR_DEFAULTS } from "./schemas/ui";
import { CONFIG_YAML_OPTIONS } from "./yaml-options";
import { atomicWrite, restoreFlowPadding, withFileLock } from "./write";
import { isLockedConfigPath, withConfigWriteLock } from "./write-lock";

const NEW_FILE_HEADER = [
  " Your additions to the model catalog. The shipped catalog (config/models.yaml) is the base: list here only the models you",
  " add or change (a model with the same id replaces the shipped one as a whole); everything else follows product updates.",
  " `deprecated: true` with just an id hides a shipped model. See docs/ai-providers.md.",
].join("\n");

export interface ModelsOverlayWrite {
  /** Ids put in the file (new or replaced), in order. */
  written: string[];
}

function backupsKeep(): number {
  try {
    return loadConfig("ui").config_editor.backups_keep;
  } catch {
    return CONFIG_EDITOR_DEFAULTS.backups_keep;
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return readUserText(file);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** An entry as plain data without the keys that are undefined; `price` and `equivalent_price` are written as flow maps like the shipped file. */
function entryNode(doc: Document, entry: CatalogModel): YAMLMap {
  const plain = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
  const node = doc.createNode(plain);
  if (isMap(node)) {
    for (const key of ["price", "equivalent_price"]) {
      const child = node.get(key, true);
      if (isMap(child)) child.flow = true;
    }
  }
  return node as YAMLMap;
}

function itemId(item: unknown): string | null {
  if (!isMap(item)) return null;
  const id = item.get("id");
  return typeof id === "string" ? id : null;
}

/** Put `entries` into `providers.<provider>.models` of the document: replace the item with the same id, else append. */
function putEntries(doc: Document, provider: AiProviderIdChoice, entries: readonly CatalogModel[]): void {
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as YAMLMap;
  let providers = doc.contents.get("providers", true);
  if (!isMap(providers)) {
    doc.contents.set("providers", doc.createNode({}));
    providers = doc.contents.get("providers", true);
  }
  if (!isMap(providers)) return;
  let section = providers.get(provider, true);
  if (!isMap(section)) {
    providers.set(provider, doc.createNode({}));
    section = providers.get(provider, true);
  }
  if (!isMap(section)) return;
  let models = section.get("models", true);
  if (!isSeq(models)) {
    section.set("models", new YAMLSeq());
    models = section.get("models", true);
  }
  if (!isSeq(models)) return;
  for (const entry of entries) {
    const node = entryNode(doc, entry);
    const index = models.items.findIndex((item) => itemId(item) === entry.id);
    if (index >= 0) models.items[index] = node;
    else models.items.push(node);
  }
}

/**
 * Add or replace `entries` (full catalog entries) of `provider` in the user's models.yaml. Throws `ConfigError` when the file
 * cannot be parsed, the result would not be a valid catalog (`schema`, naming the user's file), or the file is busy.
 */
export async function writeModelsOverlay(provider: AiProviderIdChoice, entries: readonly CatalogModel[]): Promise<ModelsOverlayWrite> {
  const filePath = getUserConfigPath("models");
  return withFileLock(filePath, () =>
    withConfigWriteLock(async () => {
      const userText = await readIfExists(filePath);
      let doc: Document;
      if (userText === null) {
        doc = new Document({ providers: {} }, CONFIG_YAML_OPTIONS);
        doc.commentBefore = NEW_FILE_HEADER;
      } else {
        doc = parseConfigDocument("models", userText, filePath);
        if (isMap(doc.contents) && documentConfigVersion(doc) === null) doc.contents.delete(CONFIG_VERSION_KEY);
        migrateConfigDocument("models", doc, filePath);
      }
      putEntries(doc, provider, entries);
      const current = currentConfigVersion("models");
      if (current > 1 && documentConfigVersion(doc) === null) stampConfigVersion(doc, current);

      const resolved = resolveConfigDocument("models", doc);
      if (resolved.errors.length > 0) {
        throw new ConfigError({ configName: "models", filePath, kind: "schema", issues: resolved.errors.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
      }
      const checked = modelsSchema.safeParse(withoutConfigVersion(resolved.value));
      if (!checked.success) {
        const issues = issuesInUserFile(zodIssues(checked.error), withoutConfigVersion(resolved.value), withoutConfigVersion(doc.toJS()));
        throw new ConfigError({ configName: "models", filePath, kind: "schema", issues });
      }

      // flow collections of the user's own text keep their padding; only what changed is written in the serializer's style
      const text = restoreFlowPadding(userText, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
      if (userText !== null && userText !== text) await backupConfigText("models", userText, backupsKeep());
      await atomicWrite(filePath, text);
      primeConfigCache("models", checked.data, text);
      return { written: entries.map((entry) => entry.id) };
    }),
  );
}

const FULL_HEADER = [
  " The full model catalog: the shipped catalog with your additions merged in, written by `pnpm models:export --full`.",
  " This file replaces nothing by itself: the shipped catalog is still the base and this file is laid over it model by model.",
  " An older version of Job Radar reads this file as the whole catalog, which is what makes it the file to keep before a downgrade.",
].join("\n");

/** The effective catalog as the text of a complete models.yaml (header comment, flow-style prices like the shipped file). */
export function renderFullModelsText(catalog: unknown): string {
  const doc = new Document(catalog, CONFIG_YAML_OPTIONS);
  doc.commentBefore = FULL_HEADER;
  visitPrices(doc.contents);
  const current = currentConfigVersion("models");
  if (current > 1) stampConfigVersion(doc, current);
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

function visitPrices(node: unknown): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = String((pair.key as { value?: unknown } | null)?.value ?? pair.key);
      if ((key === "price" || key === "equivalent_price") && isMap(pair.value)) pair.value.flow = true;
      else visitPrices(pair.value);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) visitPrices(item);
  }
}

/**
 * `pnpm models:export --full`: write the effective catalog to the user's models.yaml, under the write lock, the old text backed up;
 * or, given another path, to that file. Returns where it went and the backup, if any.
 */
export async function writeFullModels(file: string = getUserConfigPath("models")): Promise<{ file: string; backup: string | null }> {
  const userFile = getUserConfigPath("models");
  if (path.resolve(file) !== path.resolve(userFile)) {
    if (isLockedConfigPath(file)) throw new Error(`--out cannot name another file in the config or profile directory: ${path.basename(file)}`);
    return exportFullModels(file);
  }
  return withFileLock(userFile, () =>
    withConfigWriteLock(async () => {
      const effective = reloadConfig("models");
      const text = renderFullModelsText(effective);
      const old = await readIfExists(userFile);
      const backup = old !== null && old !== text ? await backupConfigText("models", old, backupsKeep()) : null;
      await atomicWrite(userFile, text);
      primeConfigCache("models", effective, text);
      return { file, backup };
    }, userFile),
  );
}

/** A copy for the user, outside the configuration: nothing reads it (outside the locked directories, see writeFullModels), so it needs neither the lock nor the database. */
async function exportFullModels(file: string): Promise<{ file: string; backup: null }> {
  await fsp.writeFile(file, renderFullModelsText(reloadConfig("models")), { mode: 0o600 });
  return { file, backup: null };
}
