/**
 * Profile save and rollback. The only code that writes `data/profile/*.yaml`, and always
 * through `writeConfig` (comments are preserved, the file is replaced atomically, the snapshot
 * hook runs). Server Actions in `app/me/actions.ts` are thin wrappers around these functions.
 */
import { z } from "zod";

import { ConfigError, mutateConfig, parseConfigText, readProfileText, reloadConfig, writeConfig, type ProfileName } from "@/lib/config";
import { meSchema } from "@/lib/config/schemas/me";
import { storiesSchema } from "@/lib/config/schemas/stories";
import { WRITER_STORIES_DEFAULTS, type WriterStoriesLimits } from "@/lib/config/schemas/writer";
import { preferencesSchema, type PreferencesConfig } from "@/lib/config/schemas/preferences";
import { getDb, getProfileSnapshot, hashProfileYaml } from "@/lib/db";
import { dealBreakerLimitProblems, slowPatternProblems } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";
import { logActionFailure } from "@/lib/logging/action-failure";
import { loadPipeline, marketSettingsProblems } from "@/lib/market";
import { storiesDraftSchema, storiesDraftToCandidate, storiesLimitProblems } from "@/lib/stories/draft";

import {
  meDraftSchema,
  meDraftToCandidate,
  preferencesDraftSchema,
  preferencesConfigToDraft,
  preferencesDraftToCandidate,
  toFieldErrors,
  type FieldError,
  type PreferencesDraft,
} from "./draft";
import { registerProfileSnapshotHook } from "./snapshots";
import type { FormErrorKey, ProfileActionState } from "./types";

function saved(kind: ProfileName): ProfileActionState {
  return { status: "saved", kind, nonce: Date.now() };
}

async function currentHash(kind: ProfileName): Promise<string> {
  return hashProfileYaml(readProfileText(kind));
}

/** pipeline.yaml `filter.deal_breakers`, or null when pipeline.yaml cannot be read (its own settings tab reports that). */
function dealBreakerLimits() {
  try {
    return loadPipeline().filter.deal_breakers;
  } catch {
    return null;
  }
}

async function failed(kind: ProfileName, formError: FormErrorKey | null, fieldErrors: FieldError[] = []): Promise<ProfileActionState> {
  return { status: "error", kind, baseHash: await currentHash(kind), fieldErrors, formError };
}

/** writer.yaml `stories` (the limits a library save must meet), or its defaults when writer.yaml cannot be read. */
function storiesLimits(): WriterStoriesLimits {
  try {
    return reloadConfig("writer").stories;
  } catch {
    return WRITER_STORIES_DEFAULTS;
  }
}

function preferencesProblems(value: PreferencesConfig): FieldError[] {
  const problems = marketSettingsProblems(value.market);
  if (problems.length > 0) return problems.map((p): FieldError => ({ path: `market.${p.field}`, ...(p.problem === "missing" ? { key: "required" } : p.problem === "unknown" ? { key: "invalidChoice" } : { key: "invalid", params: { message: p.detail ?? "" } }) }));
  const limits = dealBreakerLimits();
  const tooBig = limits === null ? [] : dealBreakerLimitProblems(value.deal_breakers, limits);
  if (tooBig.length > 0) return tooBig.map((p): FieldError => ({ path: ["deal_breakers", ...p.path.slice(0, 2)].join("."), key: p.kind === "too_many_rules" ? "tooMany" : "tooLong", params: { max: p.max } }));
  const slow = limits === null ? [] : slowPatternProblems(value.deal_breakers, limits, vmTimeBox);
  return slow.map((p): FieldError => ({ path: ["deal_breakers", ...p.path.slice(0, 2)].join("."), key: "slowPattern", params: { kind: "probe" } }));
}

/**
 * Validate `candidate` against the config schema and write it. Invalid values come back as field
 * errors with the file untouched; a failed write is told apart from a written file whose snapshot
 * step failed (`writeConfig` throws after the file was written only when the snapshot hook fails).
 */
async function write(kind: ProfileName, candidate: unknown, baseHash: string | undefined, update?: (current: PreferencesConfig) => unknown): Promise<ProfileActionState> {
  const options = baseHash === undefined ? {} : { baseHash };
  registerProfileSnapshotHook();
  let before = await currentHash(kind);
  try {
    if (kind === "me") {
      const result = meSchema.safeParse(candidate);
      if (!result.success) return failed(kind, null, toFieldErrors(result.error));
      await writeConfig("me", result.data, options);
    } else if (kind === "stories") {
      const result = storiesSchema.safeParse(candidate);
      if (!result.success) return failed(kind, null, toFieldErrors(result.error));
      const problems = storiesLimitProblems(result.data, storiesLimits());
      if (problems.length > 0) return failed(kind, null, problems);
      await writeConfig("stories", result.data, options);
    } else {
      let errors: FieldError[] = [];
      const validate = (value: unknown): PreferencesConfig | null => {
        const result = preferencesSchema.safeParse(value);
        errors = result.success ? preferencesProblems(result.data) : toFieldErrors(result.error);
        return result.success && errors.length === 0 ? result.data : null;
      };
      if (update) {
        await mutateConfig("preferences", (current) => {
          before = hashProfileYaml(readProfileText(kind));
          return validate(update(current));
        });
      } else {
        const value = validate(candidate);
        if (value !== null) await writeConfig("preferences", value, options);
      }
      if (errors.length > 0) return failed(kind, null, errors);
    }
    return saved(kind);
  } catch (error) {
    logActionFailure("saveProfile", error);
    if (error instanceof ConfigError) return failed(kind, error.kind === "frozen" ? "frozen" : error.kind === "stale" ? "stale" : "writeFailed");
    const after = await currentHash(kind).catch(() => before);
    return failed(kind, after !== before ? "snapshotFailed" : "writeFailed");
  }
}

/** Wizard steps own only part of preferences; merge their fields into the current profile under its write locks. */
export function savePreferencesPatch(patch: Partial<PreferencesDraft>): Promise<ProfileActionState> {
  return write("preferences", undefined, undefined, (current) => preferencesDraftToCandidate({ ...preferencesConfigToDraft(current), ...patch }));
}

/**
 * Validate an untrusted draft and save it as me.yaml / preferences.yaml. Never throws for bad input. `baseHash` (
 * the hash the form was opened on): a save over a file that changed since is refused with `stale`, checked here and
 * again right before the rename. The `/me` actions always pass it (a request without one is refused there); only the
 * setup wizard saves without it.
 */
export async function saveProfile(kind: "me" | "preferences", rawDraft: unknown, baseHash?: string): Promise<ProfileActionState> {
  if (baseHash !== undefined && baseHash !== (await currentHash(kind))) return failed(kind, "stale");
  if (kind === "me") {
    const draft = meDraftSchema.safeParse(rawDraft);
    if (!draft.success) return failed(kind, "invalidPayload");
    return write(kind, meDraftToCandidate(draft.data), baseHash);
  }
  const draft = preferencesDraftSchema.safeParse(rawDraft);
  if (!draft.success) return failed(kind, "invalidPayload");
  return write(kind, preferencesDraftToCandidate(draft.data), baseHash);
}

/**
 * Validate an untrusted draft of the experience library and save it as stories.yaml (ids of new stories are made from their
 * titles). Checked against the file format and the writer.yaml `stories` limits; a save over a file that changed since
 * `baseHash` is refused with `stale`. Never throws for bad input. The snapshot it leaves never makes a score stale.
 */
export async function saveStories(rawDraft: unknown, baseHash: string): Promise<ProfileActionState> {
  if (baseHash !== (await currentHash("stories"))) return failed("stories", "stale");
  const draft = storiesDraftSchema.safeParse(rawDraft);
  if (!draft.success) return failed("stories", "invalidPayload");
  return write("stories", storiesDraftToCandidate(draft.data), baseHash);
}

/** The answer to a malformed save request (a `/me` action without `{ draft, baseHash }`). */
export function invalidProfileRequest(kind: ProfileName): Promise<ProfileActionState> {
  return failed(kind, "invalidPayload");
}

const rollbackRequestSchema = z.strictObject({
  kind: z.enum(["me", "preferences", "stories"]),
  snapshotId: z.number().int().positive(),
});

/** Restore the content of a snapshot (a normal save, so it is snapshotted again). `request` is untrusted. */
export async function rollbackProfile(request: unknown): Promise<ProfileActionState> {
  const parsed = rollbackRequestSchema.safeParse(request);
  if (!parsed.success) {
    return { status: "error", kind: "me", baseHash: "", fieldErrors: [], formError: "invalidPayload" };
  }
  const { kind, snapshotId } = parsed.data;
  registerProfileSnapshotHook();
  let snapshot;
  try {
    snapshot = await getProfileSnapshot(getDb(), kind, snapshotId);
  } catch (error) {
    logActionFailure("rollbackProfile", error);
    return failed(kind, "writeFailed");
  }
  if (!snapshot) return failed(kind, "snapshotNotFound");
  let value;
  try {
    value = parseConfigText(kind, snapshot.contentYaml);
  } catch {
    return failed(kind, "snapshotInvalid");
  }
  const result = await write(kind, value, undefined);
  // a library over today's writer.yaml limits: the old version cannot be restored as it is
  if (kind === "stories" && result.status === "error" && result.formError === null) return { ...result, formError: "snapshotInvalid" };
  return result;
}
