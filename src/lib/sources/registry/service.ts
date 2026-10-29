/**
 * The only code that writes config/sources.yaml on behalf of the registry page: switches, board add / edit /
 * delete and imports. Every function validates its untrusted input with zod, re-reads the file, changes one thing, writes
 * through the shared config writer (comments stay) and mirrors the result into `source_registry`.
 */
import { logActionFailure } from "@/lib/logging/action-failure";
import { parseDocument } from "yaml";
import { z } from "zod";

import {
  ATS_KINDS,
  ConfigError,
  atsBoardEntrySchema,
  channelsSchema,
  configErrorKey,
  hashConfigText,
  mutateConfig,
  readConfigText,
  reloadConfig,
  writeConfig,
  type ChannelsConfig,
  type ConfigWriteErrorKey,
} from "@/lib/config";
import { consentKind, type ConsentKind } from "@/lib/channels/access";
import { getDb } from "@/lib/db";

import { buildRegistryEntries } from "./entries";
import {
  IMPORT_FORMATS,
  IMPORT_MODES,
  maskCredentialsInText,
  maskProxyCredentials,
  parseImportText,
  planImport,
  planRepairImport,
  type ImportChange,
  type ImportIssue,
  type ImportNote,
  type ImportSummary,
} from "./import";
import { syncSourceRegistry } from "./sync";
import { CONFIG_YAML_OPTIONS, parseConfigYamlDocument } from "@/lib/config/yaml-options";

export type RegistryErrorKey = "invalid" | "unknown_entry" | "config_invalid" | "write_failed" | "no_changes" | "database_unavailable" | "needs_parent" | "consent_required" | ConfigWriteErrorKey;

export interface FieldError {
  path: string;
  message: string;
}

export type RegistryActionState =
  | { status: "done"; outcome: "enabled" | "disabled" | "board_added" | "board_updated" | "board_removed" | "imported"; skipped?: string[] }
  | { status: "error"; error: RegistryErrorKey; fieldErrors?: FieldError[]; skipped?: string[] };

const fail = (error: RegistryErrorKey, fieldErrors?: FieldError[]): RegistryActionState => ({ status: "error", error, ...(fieldErrors ? { fieldErrors } : {}) });

/** Mirror the file into the database after a write. A failure does not undo the write: the next page load or runner reload catches up. */
async function mirror(config: ChannelsConfig): Promise<void> {
  try {
    await syncSourceRegistry(getDb(), { config, text: readConfigText("channels") });
  } catch (error) {
    logActionFailure("mirror", error);
    // the page shows "mirror out of sync" until the next sync
  }
}

function writeFailure(error: unknown): RegistryActionState {
  return fail(configErrorKey(error) ?? (error instanceof ConfigError ? "config_invalid" : "write_failed"));
}

/** A refused edit returns its state without writing; a successful edit supplies its next value and result. */
async function change(action: string, edit: (current: ChannelsConfig) => RegistryActionState | { next: ChannelsConfig; state: RegistryActionState }): Promise<RegistryActionState> {
  let state: RegistryActionState = fail("no_changes");
  try {
    const next = await mutateConfig("channels", (current) => {
      const edited = edit(current);
      if ("status" in edited) {
        state = edited;
        return null;
      }
      state = edited.state;
      return edited.next;
    });
    if (next !== null) await mirror(next);
    return state;
  } catch (error) {
    logActionFailure(action, error);
    return writeFailure(error);
  }
}

// ---------------------------------------------------------------- switches

/** `acknowledged`: the user has read the terms-of-service notice of a channel that needs one (`consentKind`); switching it on without is refused. */
const enabledRequest = z.strictObject({ id: z.string().min(1).max(200), enabled: z.boolean(), acknowledged: z.boolean().optional() });

function setAt(root: Record<string, unknown>, path: readonly (string | number)[], value: unknown): boolean {
  let cursor: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (typeof cursor !== "object" || cursor === null) return false;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  const last = path[path.length - 1];
  if (typeof cursor !== "object" || cursor === null || last === undefined) return false;
  (cursor as Record<string | number, unknown>)[last] = value;
  return true;
}

/** Switch a channel or a board on / off: only its `enabled` value changes. */
export async function setSourceEnabled(raw: unknown): Promise<RegistryActionState> {
  const request = enabledRequest.safeParse(raw);
  if (!request.success) return fail("invalid");
  return change("setSourceEnabled", (current) => {
    const entry = buildRegistryEntries(current).find((e) => e.id === request.data.id);
    if (!entry) return fail("unknown_entry");
    if (request.data.enabled && !entry.enabled && consentKind(entry.id) !== null && request.data.acknowledged !== true) return fail("consent_required");
    const next = structuredClone(current) as ChannelsConfig;
    if (!setAt(next as unknown as Record<string, unknown>, entry.enabledPath, request.data.enabled)) return fail("unknown_entry");
    // A switch whose effective value depends on another key must not claim to change nothing the user can see.
    if (buildRegistryEntries(next).find((e) => e.id === entry.id)?.enabled !== request.data.enabled) return fail("needs_parent");
    return { next, state: { status: "done", outcome: request.data.enabled ? "enabled" : "disabled" } };
  });
}

/**
 * Switch on the market's own job boards (the pack's `default_channels`) in one write; the /me market block offers
 * it after a market change. Channels already on stay as they are; none to switch on = `no_changes`. Channels that need the
 * user's acknowledgement (scraping, account automation) are never switched on here: they come back in `skipped`.
 */
export async function enableMarketChannels(defaultChannels: readonly string[]): Promise<RegistryActionState> {
  const ids = z.array(z.string().min(1).max(200)).max(50).safeParse(defaultChannels);
  if (!ids.success) return fail("invalid");
  return change("enableMarketChannels", (current) => {
    const next = structuredClone(current) as ChannelsConfig;
    const off = buildRegistryEntries(next).filter((e) => e.type === "channel" && ids.data.includes(e.id) && !e.enabled);
    const skipped = off.filter((e) => consentKind(e.id) !== null).map((e) => e.id);
    const entries = off.filter((e) => consentKind(e.id) === null);
    if (entries.length === 0) return { ...fail("no_changes"), ...(skipped.length > 0 ? { skipped } : {}) };
    for (const entry of entries) setAt(next as unknown as Record<string, unknown>, entry.enabledPath, true);
    return { next, state: { status: "done", outcome: "enabled", ...(skipped.length > 0 ? { skipped } : {}) } };
  });
}

// ---------------------------------------------------------------- boards

const boardKeySchema = z.strictObject({ ats: z.enum(ATS_KINDS), token: z.string().min(1).max(200) });
const boardRequest = z.strictObject({
  original: boardKeySchema.nullable(),
  board: z.strictObject({
    name: z.string(),
    ats: z.string(),
    token: z.string(),
    enabled: z.boolean(),
    region: z.enum(["global", "eu"]).optional(),
  }),
});

const sameBoard = (a: { ats: string; token: string }, b: { ats: string; token: string }): boolean => a.ats === b.ats && a.token.toLowerCase() === b.token.toLowerCase();

/** Field of the dialog an `ats_boards.N.<field>` issue belongs to. */
function fieldOf(path: string): string {
  const match = /^ats_boards\[(\d+)\]\.(\w+)/.exec(path) ?? /^ats_boards\.(\d+)\.(\w+)/.exec(path);
  return match?.[2] ?? "";
}

/** Add a board (`original` null) or change one. Duplicates and an EU region outside Lever come back as field errors. */
export async function saveAtsBoard(raw: unknown): Promise<RegistryActionState> {
  const request = boardRequest.safeParse(raw);
  if (!request.success) return fail("invalid");
  const { original } = request.data;
  const entry = atsBoardEntrySchema.safeParse({ ...request.data.board, name: request.data.board.name.trim(), token: request.data.board.token.trim(), ...(request.data.board.region === "eu" ? { region: "eu" } : { region: undefined }) });
  if (!entry.success) {
    return fail("invalid", entry.error.issues.map((issue) => ({ path: String(issue.path[0] ?? ""), message: issue.message })));
  }
  return change("saveAtsBoard", (current) => {
    const boards = [...current.ats_boards];
    let outcome: "board_added" | "board_updated" = "board_added";
    if (original) {
      const index = boards.findIndex((b) => sameBoard(b, original));
      if (index === -1) return fail("unknown_entry");
      boards[index] = entry.data;
      outcome = "board_updated";
    } else {
      boards.push(entry.data);
    }
    const next: ChannelsConfig = { ...current, ats_boards: boards };
    const check = channelsSchema.safeParse(next);
    if (!check.success) {
      return fail(
        "invalid",
        check.error.issues.map((issue) => ({ path: fieldOf(`ats_boards.${issue.path.slice(1).join(".")}`) || "token", message: issue.message })),
      );
    }
    return { next, state: { status: "done", outcome } };
  });
}

/** Delete a board from `ats_boards` (the postings already collected stay). */
export async function removeAtsBoard(raw: unknown): Promise<RegistryActionState> {
  const request = boardKeySchema.safeParse(raw);
  if (!request.success) return fail("invalid");
  return change("removeAtsBoard", (current) => {
    const boards = current.ats_boards.filter((b) => !sameBoard(b, request.data));
    if (boards.length === current.ats_boards.length) return fail("unknown_entry");
    return { next: { ...current, ats_boards: boards }, state: { status: "done", outcome: "board_removed" } };
  });
}

// ---------------------------------------------------------------- import

const importRequest = z.strictObject({
  text: z.string(),
  format: z.enum(IMPORT_FORMATS),
  mode: z.enum(IMPORT_MODES),
});
const applyRequest = importRequest.extend({ baseHash: z.string().min(1).max(100), acknowledged: z.boolean().optional() });

const MAX_ISSUES = 20;
const MAX_CHANGES = 500;

export type ImportPreviewState =
  | { status: "error"; error: RegistryErrorKey; issues: ImportIssue[] }
  | {
      status: "preview";
      summary: ImportSummary;
      changes: ImportChange[];
      omittedChanges: number;
      notes: ImportNote[];
      noChanges: boolean;
      baseHash: string;
      /** Channels with a terms-of-service notice that the import switches on: applying needs `acknowledged: true`. */
      consentChannels: Array<{ id: string; kind: ConsentKind }>;
    };

/** `jobspy.proxies` of a file that does not pass validation, read leniently (a repair must not drop it). */
function salvageProxies(text: string): string[] {
  try {
    // lenient on purpose (a repair keeps what it can): the shared tags, but an unresolved one does not stop the salvage
    const parsed = parseDocument(text, CONFIG_YAML_OPTIONS);
    if (parsed.errors.length > 0) return [];
    const doc: unknown = parsed.toJS();
    const jobspy = typeof doc === "object" && doc !== null ? (doc as Record<string, unknown>).jobspy : null;
    const proxies = typeof jobspy === "object" && jobspy !== null ? (jobspy as Record<string, unknown>).proxies : null;
    return Array.isArray(proxies) ? proxies.filter((p): p is string => typeof p === "string") : [];
  } catch (error) {
    logActionFailure("salvageProxies", error);
    return [];
  }
}

type Planned =
  | { ok: false; state: ImportPreviewState }
  | { ok: true; next: ChannelsConfig; plan: Extract<ReturnType<typeof planImport>, { ok: true }>; baseHash: string; repair: boolean };

function plan(input: z.infer<typeof importRequest>): Planned {
  let baseText: string;
  try {
    baseText = readConfigText("channels");
  } catch (error) {
    logActionFailure("plan", error);
    return { ok: false, state: { status: "error", error: "config_invalid", issues: [{ path: "", code: "missing_file", message: "sources.yaml is missing" }] } };
  }
  const baseHash = hashConfigText(baseText);
  let current: ChannelsConfig | null = null;
  try {
    current = reloadConfig("channels");
  } catch (error) {
    logActionFailure("plan", error);
    if (!(error instanceof ConfigError)) throw error;
  }
  const maxBytes = current?.registry.import_max_bytes ?? 524288;
  const parsed = parseImportText(input.text, input.format, maxBytes);
  if (!parsed.ok) return { ok: false, state: { status: "error", error: "invalid", issues: parsed.errors.slice(0, MAX_ISSUES) } };
  const planned = current ? planImport(current, parsed.value, input.mode) : planRepairImport(parsed.value, salvageProxies(baseText));
  if (!planned.ok) return { ok: false, state: { status: "error", error: current ? "invalid" : "config_invalid", issues: planned.errors.slice(0, MAX_ISSUES) } };
  return { ok: true, next: planned.next, plan: planned, baseHash, repair: current === null };
}

/** The channels an import switches on (they were off) that need the terms-of-service acknowledgement. */
function consentChannelsOf(changes: ImportChange[]): Array<{ id: string; kind: ConsentKind }> {
  const found: Array<{ id: string; kind: ConsentKind }> = [];
  for (const change of changes) {
    if (change.group !== "channel" || change.kind !== "enabled") continue;
    const kind = consentKind(change.target);
    if (kind !== null) found.push({ id: change.target, kind });
  }
  return found;
}

/** Validate an import and show what it would change; writes nothing. */
export async function previewSourcesImport(raw: unknown): Promise<ImportPreviewState> {
  const request = importRequest.safeParse(raw);
  if (!request.success) return { status: "error", error: "invalid", issues: [{ path: "", code: "malformed_request", message: "malformed request" }] };
  const planned = plan(request.data);
  if (!planned.ok) return planned.state;
  const { changes, summary, notes } = planned.plan;
  return {
    status: "preview",
    summary,
    changes: changes.slice(0, MAX_CHANGES),
    omittedChanges: Math.max(0, changes.length - MAX_CHANGES),
    notes,
    noChanges: changes.length === 0 && !planned.repair,
    baseHash: planned.baseHash,
    consentChannels: consentChannelsOf(changes),
  };
}

/** Apply an import: parse and validate again (the preview is not trusted), refuse when the file changed since, then write. */
export async function applySourcesImport(raw: unknown): Promise<RegistryActionState> {
  const request = applyRequest.safeParse(raw);
  if (!request.success) return fail("invalid");
  const planned = plan(request.data);
  if (!planned.ok) {
    const state = planned.state;
    return state.status === "error" ? fail(state.error, state.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path, message: i.message }))) : fail("invalid");
  }
  if (planned.baseHash !== request.data.baseHash) return fail("stale");
  if (planned.plan.changes.length === 0 && !planned.repair) return fail("no_changes");
  // an import must not switch on a scraping or account channel without the acknowledgement the switch itself asks for
  if (consentChannelsOf(planned.plan.changes).length > 0 && request.data.acknowledged !== true) return fail("consent_required");
  try {
    // Planning also supports repairing invalid YAML; the preview hash fences that read under the write locks.
    await writeConfig("channels", planned.next, { baseHash: request.data.baseHash });
    await mirror(planned.next);
    return { status: "done", outcome: "imported" };
  } catch (error) {
    logActionFailure("applySourcesImport", error);
    return writeFailure(error);
  }
}

// ---------------------------------------------------------------- export

function stamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}`;
}

/** The file as YAML (original text, comments included) or the validated values as JSON; credentials in proxy URLs are masked. */
export function exportSources(format: "yaml" | "json", options: { now: Date; timeZone: string }): { body: string; contentType: string; filename: string } | { error: "config_invalid" | "missing" } {
  const base = `sources-${stamp(options.now, options.timeZone)}`;
  let text: string;
  try {
    text = readConfigText("channels");
  } catch (error) {
    logActionFailure("exportSources", error);
    return { error: "missing" };
  }
  if (format === "yaml") {
    return { body: maskCredentialsInText(text), contentType: "application/yaml; charset=utf-8", filename: `${base}.yaml` };
  }
  try {
    const doc = parseConfigYamlDocument(text);
    if (doc.errors.length > 0) return { error: "config_invalid" };
    const config = reloadConfig("channels");
    return { body: `${JSON.stringify(maskProxyCredentials(config), null, 2)}\n`, contentType: "application/json; charset=utf-8", filename: `${base}.json` };
  } catch (error) {
    logActionFailure("exportSources", error);
    return { error: "config_invalid" };
  }
}
