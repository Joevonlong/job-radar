/**
 * The advanced config editor's server side: validate, preview, save and restore the raw text of a config file.
 * Everything the browser sends is validated with zod again here (C6), the file is re-validated before every write, and
 * a save is refused when the file changed since the editor opened it. Nothing here throws for bad input.
 */
import fs from "node:fs";

import { z } from "zod";

import { changedKeyPaths, diffYaml } from "@/lib/config/diff";
import {
  ConfigError,
  configLayer,
  configRegistry,
  getDefaultConfigPath,
  hashConfigText,
  maskConfigText,
  readConfigText,
  resetConfigToDefault,
  restoreMaskedText,
  validateConfigText,
  writeConfigText,
  type ConfigName,
  type ValidateOptions,
} from "@/lib/config";
import { signalPatternIsFast } from "@/lib/signals/pattern-guard";

import type { AdvancedFailure, AdvancedLayer, AdvancedPreview, AdvancedResetResult, AdvancedSaveResult, AdvancedValidation } from "./types";
import { advancedNameOfStem, editorLimits } from "./view";

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

function currentText(name: ConfigName): string {
  try {
    return readConfigText(name);
  } catch {
    return "";
  }
}

function currentState(name: ConfigName): { text: string; hash: string; layer: AdvancedLayer } {
  const raw = currentText(name);
  return { text: maskConfigText(name, raw), hash: hashConfigText(raw), layer: configLayer(name) };
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
  if (baseHash !== undefined && baseLayer !== undefined && (hashConfigText(currentText(name)) !== baseHash || configLayer(name) !== baseLayer)) {
    return { lines: [], paths: [], changed: false, stale: currentState(name) };
  }
  let against = "";
  if (request.data.against === "saved") {
    against = maskConfigText(name, currentText(name));
  } else {
    const shipped = getDefaultConfigPath(name);
    try {
      against = shipped === null ? "" : maskConfigText(name, fs.readFileSync(/*turbopackIgnore: true*/ shipped, "utf8"));
    } catch {
      return null;
    }
  }
  // both sides are the masked texts: a diff never carries the proxies' credentials
  const lines = diffYaml(against, request.data.text, 3);
  return { lines, paths: lines.length === 0 ? [] : changedKeyPaths(against, request.data.text), changed: lines.length > 0, stale: null };
}

function failureOf(name: ConfigName, error: unknown): AdvancedFailure {
  if (error instanceof ConfigError) {
    if (error.kind === "frozen") return { status: "frozen" };
    if (error.kind === "stale") return { status: "stale", current: currentState(name) };
    if (error.kind === "too_large") return { status: "too_large" };
    if (error.kind === "protected") return { status: "protected" };
    if (error.kind === "yaml" || error.kind === "schema" || error.kind === "version") {
      return { status: "invalid", issues: [] };
    }
  }
  return { status: "failed" };
}

export async function saveAdvanced(rawRequest: unknown): Promise<AdvancedSaveResult> {
  const request = saveSchema.safeParse(rawRequest);
  const name = request.success ? advancedNameOfStem(request.data.file) : null;
  if (!request.success || name === null) return { status: "failed" };
  const { baseHash, baseLayer, confirmOverride } = request.data;
  const limits = editorLimits();
  // the first save of a product default creates an override of the whole file: the browser must have asked
  if (configRegistry[name].kind === "shipped" && configLayer(name) === "default" && !confirmOverride) return { status: "needs_confirm" };
  // a change made behind the editor's back wins over everything else: say so with the latest text
  if (hashConfigText(currentText(name)) !== baseHash || configLayer(name) !== baseLayer) return { status: "stale", current: currentState(name) };
  const text = unmasked(name, request.data.text);
  if (!text.ok) return text.failure;
  // the issues come from the same validation the live check ran
  const checked = validateConfigText(name, text.text, validateOptions(name));
  if (!checked.ok && Buffer.byteLength(text.text, "utf8") <= limits.maxBytes) return { status: "invalid", issues: checked.issues };
  try {
    const written = await writeConfigText(name, text.text, { baseHash, baseLayer, maxBytes: limits.maxBytes, backupsKeep: limits.backupsKeep });
    const state = currentState(name);
    return { status: "saved", hash: state.hash, layer: written.layer, text: state.text, backup: written.backup !== null };
  } catch (error) {
    return failureOf(name, error);
  }
}

export async function resetAdvanced(rawRequest: unknown): Promise<AdvancedResetResult> {
  const request = resetSchema.safeParse(rawRequest);
  const name = request.success ? advancedNameOfStem(request.data.file) : null;
  if (!request.success || name === null) return { status: "failed" };
  try {
    const result = await resetConfigToDefault(name, { baseHash: request.data.baseHash, baseLayer: request.data.baseLayer, backupsKeep: editorLimits().backupsKeep });
    const state = currentState(name);
    return { status: "reset", hash: state.hash, layer: result.layer, text: state.text, backup: result.backup !== null };
  } catch (error) {
    return failureOf(name, error);
  }
}
