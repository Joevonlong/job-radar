/**
 * Settings save. The only code behind `/settings` that writes `config/*.yaml`, and always
 * through `writeConfig` (comments are preserved, the file is replaced atomically). The Server
 * Action in `app/settings/actions.ts` is a thin wrapper around `saveSettings`.
 */
import { z } from "zod";

import {
  ConfigError,
  aiSchema,
  breakdownSchema,
  salarySchema,
  channelsSchema,
  checkAiAgainstCatalog,
  hashConfigText,
  insightsSchema,
  languageSchema,
  notifySchema,
  readConfigText,
  reloadConfig,
  resumeSchema,
  scheduleSchema,
  searchSchema,
  uiSchema,
  writeConfig,
} from "@/lib/config";

import { catalogIssuesToSettingsErrors, draftToCandidate, settingsDraftSchema, toSettingsErrors, type SettingsFieldError } from "./draft";
import { isSettingsForm, SETTINGS_FORMS, type SettingsForm } from "./tabs";
import type { SettingsActionState, SettingsFormErrorKey } from "./types";

const requestSchema = z.strictObject({
  tab: z.string().refine(isSettingsForm, "unknown settings tab"),
  draft: settingsDraftSchema,
  /**
   * Hash of the file text the form was opened on; a save over a file changed since is refused (`stale`). Required:
   * a request without it is `invalidPayload` (the form always sends it).
   */
  baseHash: z.string().max(200),
});

function currentHash(tab: SettingsForm): string {
  try {
    return hashConfigText(readConfigText(tab));
  } catch {
    return "";
  }
}

function failed(tab: SettingsForm, formError: SettingsFormErrorKey | null, fieldErrors: SettingsFieldError[] = []): SettingsActionState {
  return { status: "error", tab, baseHash: currentHash(tab), fieldErrors, formError };
}

/** The config as it is on disk now, or null when the file is missing or invalid. */
function loadCurrent(tab: SettingsForm): unknown {
  try {
    return reloadConfig(tab);
  } catch (error) {
    if (error instanceof ConfigError) return null;
    throw error;
  }
}

type Validated =
  | { ok: true; write: (baseHash: string) => Promise<unknown> }
  | { ok: false; error: z.ZodError }
  /** Valid for its own schema but not against another file (the model catalog). */
  | { ok: false; fieldErrors: SettingsFieldError[]; formError: SettingsFormErrorKey | null };

/** Validate `candidate` with the schema of its file; on success `write` saves exactly what was validated. */
function validate(tab: SettingsForm, candidate: unknown): Validated {
  switch (tab) {
    case "schedule": {
      const result = scheduleSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("schedule", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "search": {
      const result = searchSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("search", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "channels": {
      const result = channelsSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("channels", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "ai": {
      const result = aiSchema.safeParse(candidate);
      if (!result.success) return { ok: false, error: result.error };
      // What is selected must exist in the catalog; the web process has no watcher, so read the file fresh
      let catalog;
      try {
        catalog = reloadConfig("models");
      } catch (error) {
        if (error instanceof ConfigError) return { ok: false, fieldErrors: [], formError: "catalogUnreadable" };
        throw error;
      }
      const problems = catalogIssuesToSettingsErrors("ai", checkAiAgainstCatalog(result.data, catalog));
      if (problems.length > 0) return { ok: false, fieldErrors: problems, formError: null };
      return { ok: true, write: (baseHash) => writeConfig("ai", result.data, { baseHash }) };
    }
    case "breakdown": {
      const result = breakdownSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("breakdown", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "salary": {
      const result = salarySchema.safeParse(candidate);
      return result.success ? { ok: true, write: () => writeConfig("salary", result.data) } : { ok: false, error: result.error };
    }
    case "notify": {
      const result = notifySchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("notify", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "language": {
      const result = languageSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("language", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "ui": {
      const result = uiSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("ui", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "insights": {
      const result = insightsSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("insights", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
    case "resume": {
      const result = resumeSchema.safeParse(candidate);
      return result.success ? { ok: true, write: (baseHash) => writeConfig("resume", result.data, { baseHash }) } : { ok: false, error: result.error };
    }
  }
}

/**
 * Validate an untrusted settings draft and save it to the config file of its tab. Values the form
 * does not show are kept from the file on disk. Invalid input comes back as field errors with the
 * file untouched; this function never throws for bad input.
 */
export async function saveSettings(rawRequest: unknown): Promise<SettingsActionState> {
  const request = requestSchema.safeParse(rawRequest);
  if (!request.success) {
    const tab = typeof rawRequest === "object" && rawRequest !== null && "tab" in rawRequest && typeof rawRequest.tab === "string" ? rawRequest.tab : "";
    return failed(isSettingsForm(tab) ? tab : (SETTINGS_FORMS[0] ?? "schedule"), "invalidPayload");
  }
  const tab = request.data.tab as SettingsForm;
  const { baseHash } = request.data;
  // a first, cheap check; writeConfig checks again right before the rename, under the file's lock
  if (baseHash !== currentHash(tab)) return failed(tab, "stale");

  const current = loadCurrent(tab);
  if (current === null) return failed(tab, "unreadable");

  const { candidate, errors } = draftToCandidate(tab, request.data.draft, current);
  const validated = validate(tab, candidate);
  if (!validated.ok || errors.length > 0) {
    if (validated.ok) return failed(tab, null, errors);
    if ("fieldErrors" in validated) return failed(tab, validated.formError, [...errors, ...validated.fieldErrors]);
    return failed(tab, null, [...errors, ...toSettingsErrors(tab, validated.error)]);
  }
  try {
    await validated.write(baseHash);
    return { status: "saved", tab, nonce: Date.now() };
  } catch (error) {
    if (error instanceof ConfigError && error.kind === "frozen") return failed(tab, "frozen");
    if (error instanceof ConfigError && error.kind === "stale") return failed(tab, "stale");
    if (error instanceof ConfigError && error.kind === "protected") return failed(tab, "protectedKeys");
    return failed(tab, "writeFailed");
  }
}
