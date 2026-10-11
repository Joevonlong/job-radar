/**
 * Form drafts for the settings page. A draft is what the browser holds and sends: one entry
 * per field of `fields.ts`, keyed by dotted path, holding plain strings, booleans and lists. It is
 * untrusted input, so it is validated with zod (C6), merged onto the config that is on disk (keys
 * the form does not show stay as they are) and then validated again with the real config schema —
 * the single source of truth for what is valid (C8).
 *
 * Pure and free of server-only imports: the client form and the server action share it.
 */
import { z } from "zod";

import { isLanguageCode } from "@/lib/i18n/languages";
import { migrateRemoteScope, parseRemoteScopeKey, remoteScopeKey } from "@/lib/market/remote-scope";
import { remoteScopeSchema } from "@/lib/market/schema";
import { issueKey, type FieldErrorKey } from "@/lib/profile/draft";

import { fieldsOf, type FieldDef } from "./fields";
import type { SettingsForm } from "./tabs";

export interface KeywordGroupDraft {
  id: string;
  keywords: string[];
}
/** One provider of a task's own order, with the model chosen for it ("" = the provider's default). */
export interface RouteDraft {
  provider: string;
  model: string;
}
export type DraftValue = string | boolean | string[] | KeywordGroupDraft[] | RouteDraft[];
/** One entry per field, keyed by the field's dotted path. */
export type SettingsDraft = Record<string, DraftValue>;

export const settingsDraftSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.strictObject({ id: z.string(), keywords: z.array(z.string()) })),
    z.array(z.strictObject({ provider: z.string(), model: z.string() })),
  ]),
);

// ---------------------------------------------------------------- plain-object helpers

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getAt(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (!isObj(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Set (or, for `undefined`, remove) the value at `path`; intermediate objects are created. */
function setAt(root: Obj, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = root;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (isObj(next)) {
      current = next;
    } else {
      const created: Obj = {};
      current[key] = created;
      current = created;
    }
  }
  const last = keys[keys.length - 1] ?? "";
  if (value === undefined) delete current[last];
  else current[last] = value;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Text field -> number for the config schema: empty = missing (reported as "required"), anything but a plain decimal = NaN. */
export function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
}

// ---------------------------------------------------------------- config -> draft

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function fieldToDraft(def: FieldDef, value: unknown): DraftValue {
  switch (def.kind) {
    case "bool":
      return value === true;
    case "int":
    case "number":
      return typeof value === "number" ? String(value) : "";
    case "text":
    case "select":
    case "model":
      return typeof value === "string" ? value : "";
    case "tags":
    case "ordered":
      return asStrings(value);
    case "numberList":
      return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number").map(String) : [];
    case "keywordGroups":
      return isObj(value) ? Object.entries(value).map(([id, keywords]): KeywordGroupDraft => ({ id, keywords: asStrings(keywords) })) : [];
    case "remoteScope": {
      const scope = remoteScopeSchema.safeParse(migrateRemoteScope(value));
      return scope.success ? remoteScopeKey(scope.data) : typeof value === "string" ? value : "";
    }
    case "route": {
      const order = asStrings(getAt(value, "order"));
      const chosen = getAt(value, "models");
      return order.map((provider): RouteDraft => ({ provider, model: isObj(chosen) && typeof chosen[provider] === "string" ? chosen[provider] : "" }));
    }
  }
}

/** The form values for the config file `tab` (`config` is the validated, loaded value). */
export function configToDraft(tab: SettingsForm, config: unknown): SettingsDraft {
  const draft: SettingsDraft = {};
  for (const def of fieldsOf(tab)) draft[def.path] = fieldToDraft(def, getAt(config, def.path));
  return draft;
}

// ---------------------------------------------------------------- draft -> candidate

export type SettingsErrorKey =
  | FieldErrorKey
  | "url"
  | "cron"
  | "timezone"
  | "clockTime"
  | "country"
  | "overBudgetCap"
  | "delayOrder"
  | "pollOrder"
  /** (ui.yaml) The salary axis maximum is not above its minimum / a tick step does not fit / the warning hours are not below the decay hours. */
  | "axisOrder"
  | "tickTooLarge"
  | "warnOrder"
  /** A selected model that is not in the provider's catalog (models.yaml). */
  | "modelNotInCatalog"
  /** The codex model does not support the chosen reasoning effort. */
  | "effortUnsupported"
  /** Models chosen for a task without an order of its own / for a provider not in that order. */
  | "taskModelsNeedOrder"
  | "taskModelNotInOrder"
  | "groupId"
  /** (resume.yaml / insights.yaml). */
  | "absolutePath"
  | "sortedAsc"
  | "notInRanges"
  | "capOrder"
  /** A positive number: zero is not allowed either (`min` is the bound that is not allowed). */
  | "greaterThan"
  /** A number above its upper bound (`max`). */
  | "max"
  /** (language.yaml) Not a BCP 47 language code. */
  | "languageTag";

export interface SettingsFieldError {
  /** Field path (as in `fields.ts`), or "" for a problem that belongs to no field. */
  path: string;
  key: SettingsErrorKey;
  params?: Record<string, string | number>;
  /** Dotted config path of the first issue, shown for errors without a field. */
  configPath?: string;
}

function fieldValue(def: FieldDef, value: DraftValue, errors: SettingsFieldError[]): unknown {
  switch (def.kind) {
    case "bool":
      return typeof value === "boolean" ? value : false;
    case "int":
    case "number":
      return typeof value === "string" ? toNumber(value) : undefined;
    case "text":
    case "select":
    case "model": {
      const str = typeof value === "string" ? value : "";
      if (str.trim() === "") {
        if (def.nullable) return null;
        if (def.optional) return undefined;
      }
      return str;
    }
    case "tags":
    case "ordered": {
      const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return def.optional && list.length === 0 ? undefined : list;
    }
    case "numberList": {
      const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      return list.map((entry) => toNumber(entry) ?? Number.NaN);
    }
    case "keywordGroups": {
      const out: Record<string, string[]> = {};
      for (const row of Array.isArray(value) ? value : []) {
        if (typeof row !== "object" || !("keywords" in row)) continue;
        const id = row.id.trim();
        if (Object.hasOwn(out, id)) {
          errors.push({ path: def.path, key: "duplicates" });
          continue;
        }
        out[id] = row.keywords;
      }
      return out;
    }
    case "remoteScope": {
      const key = typeof value === "string" ? value : "";
      // an incomplete key ("region:" with nothing picked) goes to the schema as is and comes back as a field error
      return parseRemoteScopeKey(key) ?? key;
    }
    case "route": {
      const rows = (Array.isArray(value) ? value : []).filter((row): row is RouteDraft => typeof row === "object" && "provider" in row);
      if (rows.length === 0) return {};
      const providers = rows.map((row) => row.provider.trim());
      if (new Set(providers).size !== providers.length) errors.push({ path: def.path, key: "duplicates" });
      const models: Record<string, string> = {};
      for (const row of rows) {
        const provider = row.provider.trim();
        if (provider !== "api" && row.model.trim() !== "") models[provider] = row.model.trim();
      }
      return { order: providers, ...(Object.keys(models).length > 0 ? { models } : {}) };
    }
  }
}

/**
 * The config candidate for a draft: a copy of `current` (the file as it is on disk) with every
 * field of the form replaced by the draft's value. Feed `candidate` to the config schema; `errors`
 * are problems found while converting (duplicate keys) that the schema would not see.
 */
export function draftToCandidate(tab: SettingsForm, draft: SettingsDraft, current: unknown): { candidate: unknown; errors: SettingsFieldError[] } {
  const candidate: Obj = isObj(current) ? structuredClone(current) : {};
  const errors: SettingsFieldError[] = [];
  for (const def of fieldsOf(tab)) {
    const value = draft[def.path];
    if (value === undefined) continue;
    setAt(candidate, def.path, fieldValue(def, value, errors));
  }
  return { candidate, errors };
}

// ---------------------------------------------------------------- errors

type Issue = z.core.$ZodIssue;

function dotted(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

/** The field a zod issue path belongs to: the longest field path that is a prefix of it. */
export function fieldPathOf(tab: SettingsForm, path: ReadonlyArray<PropertyKey>): string {
  const issuePath = dotted(path);
  let best = "";
  for (const def of fieldsOf(tab)) {
    if ((issuePath === def.path || issuePath.startsWith(`${def.path}.`)) && def.path.length > best.length) best = def.path;
  }
  return best;
}

export function settingsIssueKey(issue: Issue): Pick<SettingsFieldError, "key" | "params"> {
  const message = issue.message;
  if (issue.code === "invalid_format") {
    if (issue.format === "url") return { key: "url" };
    if (message.startsWith("must be HH:MM")) return { key: "clockTime" };
    if (message.startsWith("must be an ISO 3166-1")) return { key: "country" };
  }
  if (issue.code === "invalid_key") return { key: "groupId" };
  if (issue.code === "custom") {
    if (message.startsWith("invalid cron expression")) return { key: "cron", params: { detail: message.replace(/^invalid cron expression:\s*/, "") } };
    if (message === "must be a valid IANA time zone") return { key: "timezone" };
    if (message === "must not exceed paid_total_monthly_budget_usd") return { key: "overBudgetCap" };
    if (message.includes("min_delay_ms must be <= max_delay_ms")) return { key: "delayOrder" };
    if (message.includes("poll_interval_ms must be <= timeout_ms")) return { key: "pollOrder" };
    if (message === "must be larger than min_k") return { key: "axisOrder" };
    if (message.startsWith("must be smaller than the axis")) return { key: "tickTooLarge" };
    if (message === "must be smaller than decay_hours") return { key: "warnOrder" };
    if (message === "models needs the task's own order") return { key: "taskModelsNeedOrder" };
    if (/^provider "[^"]+" is not in tasks\.\w+\.order$/.test(message)) return { key: "taskModelNotInOrder" };
    if (message === "needs at least one keyword group") return { key: "atLeastOne" };
    if (message === "must be an absolute path") return { key: "absolutePath" };
    if (message === "must be sorted from shortest to longest") return { key: "sortedAsc" };
    if (message === "must be one of ranges_days") return { key: "notInRanges" };
    if (/^must be larger than (score_bucket_width|salary_bucket)$/.test(message)) return { key: "capOrder" };
    if (message.startsWith("must be a language code")) return { key: "languageTag" };
    if (message.startsWith("must not repeat a language")) return { key: "duplicates" };
  }
  if (issue.code === "invalid_type" && issue.expected === "object") return { key: "required" };
  if (issue.code === "too_big" && issue.origin === "number") return { key: "max", params: { max: Number(issue.maximum) } };
  if (issue.code === "too_small" && issue.origin === "number" && issue.inclusive === false) return { key: "greaterThan", params: { min: Number(issue.minimum) } };
  return issueKey(issue);
}

/**
 * Problems the browser can see without asking the server: a value of a language-code field that is not a language code.
 * Empty text is left to the server (a required key reports it on save). The same rule is the config schema's, so the
 * server still refuses what slips through.
 */
export function clientFieldErrors(tab: SettingsForm, draft: SettingsDraft): SettingsFieldError[] {
  const out: SettingsFieldError[] = [];
  for (const def of fieldsOf(tab)) {
    if (def.languageCode !== true) continue;
    const value = draft[def.path];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    if (values.some((v) => v.trim() !== "" && !isLanguageCode(v.trim()))) out.push({ path: def.path, key: "languageTag" });
  }
  return out;
}

/** Zod issues of the config schema -> field errors (one per field and kind), addressed by field path. */
export function toSettingsErrors(tab: SettingsForm, error: z.ZodError): SettingsFieldError[] {
  const seen = new Set<string>();
  const out: SettingsFieldError[] = [];
  for (const issue of error.issues) {
    const path = fieldPathOf(tab, issue.path);
    const mapped = settingsIssueKey(issue);
    const id = `${path}|${mapped.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ path, ...mapped, ...(path === "" ? { configPath: dotted(issue.path) } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- catalog check

/** Where in the form a path of ai.yaml is edited (one field per model choice; the task's `route` field covers `tasks.<t>.models.*`). */
export function catalogIssuesToSettingsErrors(
  tab: SettingsForm,
  issues: readonly { path: (string | number)[]; code: "not_in_catalog" | "deprecated" | "effort_unsupported"; severity: "error" | "warning"; model: string; effort?: string }[],
): SettingsFieldError[] {
  const out: SettingsFieldError[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    const path = fieldPathOf(tab, issue.path);
    const key: SettingsErrorKey = issue.code === "effort_unsupported" ? "effortUnsupported" : "modelNotInCatalog";
    const id = `${path}|${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ path, key, params: { model: issue.model === "" ? "CLI" : issue.model, ...(issue.effort ? { effort: issue.effort } : {}) } });
  }
  return out;
}
