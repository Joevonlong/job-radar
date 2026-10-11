/**
 * Profile save and rollback. The only code that writes `data/profile/*.yaml`, and always
 * through `writeConfig` (comments are preserved, the file is replaced atomically, the snapshot
 * hook runs). Server Actions in `app/me/actions.ts` are thin wrappers around these functions.
 */
import { z } from "zod";

import { ConfigError, ensureProfileFiles, parseConfigText, readConfigText, writeConfig, type ProfileName } from "@/lib/config";
import { meSchema } from "@/lib/config/schemas/me";
import { preferencesSchema } from "@/lib/config/schemas/preferences";
import { getDb, getProfileSnapshot, hashProfileYaml } from "@/lib/db";
import { dealBreakerLimitProblems } from "@/lib/filter/deal-breakers";
import { loadPipeline, marketSettingsProblems } from "@/lib/market";

import {
  meDraftSchema,
  meDraftToCandidate,
  preferencesDraftSchema,
  preferencesDraftToCandidate,
  toFieldErrors,
  type FieldError,
} from "./draft";
import { registerProfileSnapshotHook } from "./snapshots";
import type { FormErrorKey, ProfileActionState } from "./types";

function saved(kind: ProfileName): ProfileActionState {
  return { status: "saved", kind, nonce: Date.now() };
}

async function currentHash(kind: ProfileName): Promise<string> {
  await ensureProfileFiles();
  return hashProfileYaml(readConfigText(kind));
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

/**
 * Validate `candidate` against the config schema and write it. Invalid values come back as field
 * errors with the file untouched; a failed write is told apart from a written file whose snapshot
 * step failed (`writeConfig` throws after the file was written only when the snapshot hook fails).
 */
async function write(kind: ProfileName, candidate: unknown, baseHash: string | undefined): Promise<ProfileActionState> {
  const options = baseHash === undefined ? {} : { baseHash };
  registerProfileSnapshotHook();
  const before = await currentHash(kind);
  try {
    if (kind === "me") {
      const result = meSchema.safeParse(candidate);
      if (!result.success) return failed(kind, null, toFieldErrors(result.error));
      await writeConfig("me", result.data, options);
    } else {
      const result = preferencesSchema.safeParse(candidate);
      if (!result.success) return failed(kind, null, toFieldErrors(result.error));
      // A market that cannot be resolved would stop every market step, so it is not saved
      const problems = marketSettingsProblems(result.data.market);
      if (problems.length > 0) {
        return failed(
          kind,
          null,
          problems.map((p): FieldError => ({ path: `market.${p.field}`, ...(p.problem === "missing" ? { key: "required" } : p.problem === "unknown" ? { key: "invalidChoice" } : { key: "invalid", params: { message: p.detail ?? "" } }) })),
        );
      }
      // the limits of pipeline.yaml (`filter.deal_breakers`): more rules or longer patterns than it allows are not saved
      const limits = dealBreakerLimits();
      const tooBig = limits === null ? [] : dealBreakerLimitProblems(result.data.deal_breakers, limits);
      if (tooBig.length > 0) {
        return failed(
          kind,
          null,
          tooBig.map((p): FieldError => ({ path: ["deal_breakers", ...p.path.slice(0, 2)].join("."), key: p.kind === "too_many_rules" ? "tooMany" : "tooLong", params: { max: p.max } })),
        );
      }
      await writeConfig("preferences", result.data, options);
    }
    return saved(kind);
  } catch (error) {
    if (error instanceof ConfigError) return failed(kind, error.kind === "stale" ? "stale" : "writeFailed");
    const after = await currentHash(kind).catch(() => before);
    return failed(kind, after !== before ? "snapshotFailed" : "writeFailed");
  }
}

/**
 * Validate an untrusted draft and save it as me.yaml / preferences.yaml. Never throws for bad input. `baseHash` (
 * the hash the form was opened on): a save over a file that changed since is refused with `stale`, checked here and
 * again right before the rename. The `/me` actions always pass it (a request without one is refused there); only the
 * setup wizard saves without it.
 */
export async function saveProfile(kind: ProfileName, rawDraft: unknown, baseHash?: string): Promise<ProfileActionState> {
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

/** The answer to a malformed save request (a `/me` action without `{ draft, baseHash }`). */
export function invalidProfileRequest(kind: ProfileName): Promise<ProfileActionState> {
  return failed(kind, "invalidPayload");
}

const rollbackRequestSchema = z.strictObject({
  kind: z.enum(["me", "preferences"]),
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
  } catch {
    return failed(kind, "writeFailed");
  }
  if (!snapshot) return failed(kind, "snapshotNotFound");
  let value;
  try {
    value = parseConfigText(kind, snapshot.contentYaml);
  } catch {
    return failed(kind, "snapshotInvalid");
  }
  return write(kind, value, undefined);
}
