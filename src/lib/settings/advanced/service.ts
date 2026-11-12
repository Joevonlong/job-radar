/**
 * The advanced config editor's server side: validate, preview, save and restore the raw text of a config file.
 * Everything the browser sends is validated with zod again here, the file is re-validated before every write, and
 * a save is refused when the file changed since the editor opened it. Nothing here throws for bad input.
 */
import { z } from "zod";

import { changedKeyPaths, diffYaml } from "@/lib/config/diff";
import {
  ConfigError,
  configLayer,
  documentConfigVersion,
  getDefaultConfigPath,
  hasOverlayFormat,
  isOverlayVersion,
  layeredConfigFingerprint,
  maskConfigText,
  migrateConfigDocument,
  parseConfigDocument,
  readEffectiveConfig,
  readOverlayText,
  readShippedText,
  resetConfigToDefault,
  restoreMaskedText,
  validateConfigText,
  writeConfigRepair,
  writeConfigText,
  type ConfigName,
  type ValidateOptions,
} from "@/lib/config";
import { shippedEffective } from "@/lib/config/load";
import { toFullText } from "@/lib/config/to-full";
import { stringifyConfigYaml } from "@/lib/config/yaml-options";
import { signalPatternIsFast } from "@/lib/signals/pattern-guard";
import { logActionFailure } from "@/lib/logging/action-failure";
import { ownerMayChange, type OwnerSessionState } from "@/lib/security/owner-session";

import type { AdvancedFailure, AdvancedLayer, AdvancedPreview, AdvancedResetResult, AdvancedSaveResult, AdvancedValidation } from "./types";
import { advancedNameOfStem, canResetFile, editorLimits, editorText } from "./view";

/** Hard ceiling for the text field whatever ui.yaml says (the real limit, `config_editor.max_bytes`, is checked after it). */
const MAX_TEXT_CHARS = 4_000_000;

const stemSchema = z.string().min(1).max(40);
const layerSchema = z.enum(["user", "default", "missing"]);
const textSchema = z.string().max(MAX_TEXT_CHARS);

const validateSchema = z.strictObject({ file: stemSchema, text: textSchema });
const previewSchema = z.strictObject({ file: stemSchema, text: textSchema, against: z.enum(["saved", "default"]), baseHash: z.string().max(80).optional(), baseLayer: layerSchema.optional() });
const saveSchema = z.strictObject({ file: stemSchema, text: textSchema, baseHash: z.string().max(80), baseLayer: layerSchema, confirmOverride: z.boolean() });
const resetSchema = z.strictObject({ file: stemSchema, baseHash: z.string().max(80), baseLayer: layerSchema });

/**
 * The checks of a save besides the schema: interests.yaml patterns that are too slow on the probe's test texts (with the
 * text's own limits) are issues; the rules would leave them out of every scan.
 */
const validateOptions = (name: ConfigName): ValidateOptions => (name === "interests" ? { checkProtected: true, interestsProbe: (limits) => signalPatternIsFast(limits) } : { checkProtected: true });

/**
 * Who may write: mcp.yaml decides what agents can read and change, so once a web password is set its raw text can only be saved,
 * reset or repaired with a session, as on the agent access page. Every other file is unaffected. A caller that does not say is
 * treated as having no session.
 */
export interface AdvancedWriteOptions {
  ownerSession: OwnerSessionState;
}

const NO_SESSION: AdvancedWriteOptions = { ownerSession: "login_required" };

function sessionBlocks(name: ConfigName, options: AdvancedWriteOptions): boolean {
  return name === "mcp" && !ownerMayChange(options.ownerSession);
}

/** The user's file ("" without one or when it cannot be read). */
function currentText(name: ConfigName): string {
  try {
    return readOverlayText(name) ?? "";
  } catch {
    return "";
  }
}

function fingerprint(name: ConfigName): string {
  try {
    return layeredConfigFingerprint(name);
  } catch {
    return "";
  }
}

function currentState(name: ConfigName): { text: string; hash: string; layer: AdvancedLayer; canReset: boolean } {
  let text = "";
  try {
    text = editorText(name);
  } catch {
    // no layer to read: the editor starts empty
  }
  return { text: maskConfigText(name, text), hash: fingerprint(name), layer: configLayer(name), canReset: canResetFile(name) };
}

/**
 * What a text means as a whole file: an overlay laid over the shipped file (`text` null: the shipped file alone). Comments are
 * kept. Null when it cannot be worked out (an invalid text, no shipped file): the preview then compares the plain texts.
 */
function effectiveText(name: ConfigName, text: string | null): string | null {
  const shippedFile = getDefaultConfigPath(name);
  if (!hasOverlayFormat(name) || shippedFile === null) return null;
  try {
    const shippedSource = readShippedText(name);
    if (shippedSource === null) return null;
    const shipped = shippedEffective(name, shippedSource, shippedFile).doc;
    if (text === null) return toFullText(name, shipped, null);
    const doc = parseConfigDocument(name, text, shippedFile);
    migrateConfigDocument(name, doc, shippedFile);
    return isOverlayVersion(name, documentConfigVersion(doc)) ? toFullText(name, shipped, doc) : stringifyConfigYaml(doc);
  } catch {
    return null;
  }
}

/** What the editor sent, with the masked proxy entries put back; or the failure to report. */
function unmasked(name: ConfigName, submitted: string): { ok: true; text: string } | { ok: false; failure: AdvancedFailure } {
  const restored = restoreMaskedText(name, submitted, currentText(name));
  return restored.ok ? { ok: true, text: restored.text } : { ok: false, failure: { status: "proxies_changed" } };
}

export async function validateAdvanced(rawRequest: unknown): Promise<AdvancedValidation> {
  const request = validateSchema.safeParse(rawRequest);
  const name = request.success ? advancedNameOfStem(request.data.file) : null;
  if (!request.success || name === null) return { ok: false, issues: [{ path: "", message: "invalid request", line: 1, col: 1, exact: false, source: "yaml" }], warnings: [] };
  const text = unmasked(name, request.data.text);
  if (!text.ok) return { ok: false, issues: [{ path: "jobspy.proxies", message: "proxies_changed", line: 1, col: 1, exact: false, source: "schema" }], warnings: [] };
  const result = validateConfigText(name, text.text, validateOptions(name));
  return result.ok ? { ok: true, issues: [], warnings: result.warnings } : { ok: false, issues: result.issues, warnings: [] };
}

export async function previewAdvanced(rawRequest: unknown): Promise<AdvancedPreview | null> {
  const request = previewSchema.safeParse(rawRequest);
  const name = request.success ? advancedNameOfStem(request.data.file) : null;
  if (!request.success || name === null) return null;
  const { baseHash, baseLayer } = request.data;
  // a change made behind the editor's back is reported now, not only when "Save" is pressed
  if (baseHash !== undefined && baseLayer !== undefined && (fingerprint(name) !== baseHash || configLayer(name) !== baseLayer)) {
    return { lines: [], paths: [], changed: false, stale: currentState(name) };
  }
  // the saved side, as a whole file and, when that cannot be worked out, as the text in the file
  let savedText: string | null = null;
  try {
    savedText = readOverlayText(name);
  } catch {
    return null;
  }
  const from = request.data.against === "saved" ? savedText : null;
  const effectiveAgainst = effectiveText(name, from);
  const effectiveNext = effectiveText(name, request.data.text);
  let against: string;
  let next: string;
  if (effectiveAgainst !== null && effectiveNext !== null) {
    against = effectiveAgainst;
    next = effectiveNext;
  } else {
    next = request.data.text;
    try {
      against = request.data.against === "saved" ? (savedText ?? "") : (readShippedText(name) ?? "");
    } catch {
      return null;
    }
  }
  // both sides are masked: a diff never carries the proxies' credentials
  against = maskConfigText(name, against);
  next = maskConfigText(name, next);
  const lines = diffYaml(against, next, 3);
  return { lines, paths: lines.length === 0 ? [] : changedKeyPaths(against, next), changed: lines.length > 0, stale: null };
}

function failureOf(name: ConfigName, error: unknown): AdvancedFailure {
  if (error instanceof ConfigError) {
    if (error.kind === "db_unavailable") return { status: "dbUnavailable" };
    if (error.kind === "stale") return { status: "stale", current: currentState(name) };
    if (error.kind === "too_large") return { status: "too_large" };
    if (error.kind === "protected") return { status: "protected" };
    if (error.kind === "yaml" || error.kind === "schema" || error.kind === "version") {
      return { status: "invalid", issues: [] };
    }
  }
  return { status: "failed" };
}

function needsRepair(name: ConfigName, text: string): boolean {
  if (!hasOverlayFormat(name) || readOverlayText(name) === null) return false;
  try {
    readEffectiveConfig(name);
    return false;
  } catch {
    const file = getDefaultConfigPath(name) ?? "";
    return !isOverlayVersion(name, documentConfigVersion(parseConfigDocument(name, text, file)));
  }
}

export async function saveAdvanced(rawRequest: unknown, options: AdvancedWriteOptions = NO_SESSION): Promise<AdvancedSaveResult> {
  const request = saveSchema.safeParse(rawRequest);
  const name = request.success ? advancedNameOfStem(request.data.file) : null;
  if (!request.success || name === null) return { status: "failed" };
  if (sessionBlocks(name, options)) return { status: "session_required" };
  const { baseHash, baseLayer, confirmOverride } = request.data;
  const limits = editorLimits();
  // models.yaml keeps its by-id overlay: the first save of the full catalog pins every model in it, so the browser must have asked
  if (name === "models" && configLayer(name) === "default" && !confirmOverride) return { status: "needs_confirm" };
  // a change made behind the editor's back wins over everything else: say so with the latest text
  if (fingerprint(name) !== baseHash || configLayer(name) !== baseLayer) return { status: "stale", current: currentState(name) };
  const text = unmasked(name, request.data.text);
  if (!text.ok) return text.failure;
  // the issues come from the same validation the live check ran
  const checked = validateConfigText(name, text.text, validateOptions(name));
  if (!checked.ok && Buffer.byteLength(text.text, "utf8") <= limits.maxBytes) return { status: "invalid", issues: checked.issues };
  try {
    // No usable value now, and the text is a whole file: the repair entry, which writes the format a new file gets. An overlay is saved as written.
    if (checked.ok && needsRepair(name, text.text)) {
      await writeConfigRepair(name, checked.value, { previewFingerprint: baseHash });
      const state = currentState(name);
      return { status: "saved", hash: state.hash, layer: "user", text: state.text, canReset: state.canReset, backup: baseLayer === "user" };
    }
    const written = await writeConfigText(name, text.text, { baseHash, baseLayer, maxBytes: limits.maxBytes, backupsKeep: limits.backupsKeep });
    const state = currentState(name);
    return { status: "saved", hash: state.hash, layer: written.layer, text: state.text, canReset: state.canReset, backup: written.backup !== null };
  } catch (error) {
    logActionFailure("saveAdvanced", error);
    return failureOf(name, error);
  }
}

export async function resetAdvanced(rawRequest: unknown, options: AdvancedWriteOptions = NO_SESSION): Promise<AdvancedResetResult> {
  const request = resetSchema.safeParse(rawRequest);
  const name = request.success ? advancedNameOfStem(request.data.file) : null;
  if (!request.success || name === null) return { status: "failed" };
  if (sessionBlocks(name, options)) return { status: "session_required" };
  try {
    const result = await resetConfigToDefault(name, { baseHash: request.data.baseHash, baseLayer: request.data.baseLayer, backupsKeep: editorLimits().backupsKeep });
    const state = currentState(name);
    return { status: "reset", hash: state.hash, layer: result.layer, text: state.text, canReset: state.canReset, backup: result.backup !== null };
  } catch (error) {
    logActionFailure("resetAdvanced", error);
    return failureOf(name, error);
  }
}
