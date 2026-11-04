/** Server side of the advanced editor: the file list, one file's text, the limits. Reads only. */
import {
  CONFIG_EDITOR_DEFAULTS,
  CONFIG_NAMES,
  ConfigError,
  configLayer,
  configRegistry,
  displayConfigPathForWeb,
  documentConfigVersion,
  currentConfigVersion,
  inspectOverlayFiles,
  isProfileName,
  layeredConfigFingerprint,
  maskConfigText,
  newFileText,
  readEffectiveConfig,
  readOverlayText,
  readShippedText,
  reloadConfig,
  resolveConfigPath,
  validateConfigText,
  type ConfigName,
} from "@/lib/config";
import { protectedEditAllowed, protectedPatterns } from "@/lib/config/protected-keys";

import type { AdvancedFileEntry, AdvancedLayer, AdvancedLoad } from "./types";
import { parseConfigYamlDocument } from "@/lib/config/yaml-options";

/** The configs the editor lists: the layered ones (the profile files have their own pages). In the registry's order. */
export const ADVANCED_NAMES: readonly ConfigName[] = CONFIG_NAMES.filter((name) => !isProfileName(name));

/** `sources` for `channels` (the file's name without `.yaml`). */
export function advancedStem(name: ConfigName): string {
  return configRegistry[name].file.replace(/\.yaml$/, "");
}

/** The config behind `?file=<stem>`; the registry name (`channels`) works too. */
export function advancedNameOfStem(stem: string): ConfigName | null {
  return ADVANCED_NAMES.find((name) => advancedStem(name) === stem || name === stem) ?? null;
}

/** The editor's limits from ui.yaml; the defaults when ui.yaml cannot be read (so a broken ui.yaml can be repaired here). */
export function editorLimits(): { maxBytes: number; backupsKeep: number } {
  try {
    const { config_editor } = reloadConfig("ui");
    return { maxBytes: config_editor.max_bytes, backupsKeep: config_editor.backups_keep };
  } catch {
    return { maxBytes: CONFIG_EDITOR_DEFAULTS.max_bytes, backupsKeep: CONFIG_EDITOR_DEFAULTS.backups_keep };
  }
}

function firstLine(issue: { path: string; message: string } | undefined, fallback: string): string {
  return issue ? `${issue.path === "" ? "(root)" : issue.path}: ${issue.message}` : fallback;
}

/** What the editor opens: the user's file, or the template of a file created now. */
export function editorText(name: ConfigName): string {
  return readOverlayText(name) ?? newFileText(name);
}

function readText(name: ConfigName): { text: string } | { problem: string } {
  try {
    return { text: editorText(name) };
  } catch (error) {
    return { problem: error instanceof ConfigError ? (error.message.split("\n")[0] ?? "unreadable") : "unreadable" };
  }
}

function entryOf(name: ConfigName): AdvancedFileEntry {
  const registry = configRegistry[name];
  const layer: AdvancedLayer = configLayer(name);
  let valid = false;
  let firstProblem: string | null = null;
  let versionBehind = false;
  try {
    const text = readOverlayText(name);
    if (text === null) {
      readEffectiveConfig(name);
      valid = true;
    } else {
      const result = validateConfigText(name, text);
      valid = result.ok;
      if (!result.ok) firstProblem = firstLine(result.issues[0], "invalid");
      const doc = parseConfigYamlDocument(text, { unset: "overlay" });
      const version = doc.errors.length === 0 ? documentConfigVersion(doc) : null;
      versionBehind = version !== null && version < currentConfigVersion(name);
    }
  } catch (error) {
    firstProblem = error instanceof ConfigError ? (error.message.split("\n")[0] ?? "unreadable") : "unreadable";
  }
  return {
    stem: advancedStem(name),
    file: registry.file,
    group: registry.kind,
    layer,
    overridden: registry.kind === "shipped" && layer === "user",
    valid,
    firstProblem,
    versionBehind,
  };
}

/** Every file with where it is read from, whether it is valid and whether its version is behind. Never throws. */
export function loadAdvancedIndex(): AdvancedFileEntry[] {
  return ADVANCED_NAMES.map(entryOf);
}

/**
 * Whether "restore the default" has something to undo: the user file lays at least one override, unset or pin over the shipped file.
 * A file that is only a stub or comments changes nothing, so the button stays hidden. A whole-file (older format) or unreadable file
 * is not an overlay: it replaces the shipped file, so it can always be restored.
 */
export function canResetFile(name: ConfigName): boolean {
  let hasDefault = false;
  try {
    hasDefault = readShippedText(name) !== null;
  } catch {
    hasDefault = false;
  }
  return hasDefault && configLayer(name) === "user" && name !== "setup" && overlayNotEmpty(name);
}

function overlayNotEmpty(name: ConfigName): boolean {
  const file = inspectOverlayFiles([name])[0];
  if (file === undefined) return readOverlayText(name) !== null;
  return file.format !== "overlay" || file.entries.length > 0;
}

export function loadAdvancedFile(stem: string): AdvancedLoad {
  const name = advancedNameOfStem(stem);
  if (name === null) return { ok: false, reason: "unknown_file" };
  const read = readText(name);
  if ("problem" in read) return { ok: false, reason: "unreadable" };
  const layer: AdvancedLayer = configLayer(name);
  let defaultText: string | null = null;
  let hash = "";
  try {
    defaultText = readShippedText(name);
    hash = layeredConfigFingerprint(name);
  } catch {
    if (hash === "") return { ok: false, reason: "unreadable" };
  }
  return {
    ok: true,
    data: {
      entry: entryOf(name),
      path: displayConfigPathForWeb(resolveConfigPath(name)),
      hash,
      layer,
      text: maskConfigText(name, read.text),
      defaultText: defaultText === null ? null : maskConfigText(name, defaultText),
      codeVersion: currentConfigVersion(name),
      maxBytes: editorLimits().maxBytes,
      canReset: defaultText !== null && canResetFile(name),
      protectedKeys: [...protectedPatterns(name)],
      protectedUnlocked: protectedEditAllowed(),
    },
  };
}
