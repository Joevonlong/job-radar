"use server";

import { diffLines } from "diff";
import { z } from "zod";

import { readCareerGate } from "@/lib/config/career-gate";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { saveContact } from "@/lib/career/contact/store";
import { careerContactSchema } from "@/lib/career/schema/contact";
import { careerProfileSchema, profileContent } from "@/lib/career/schema/profile";
import { clearCareerHistory, deleteCareerData } from "@/lib/career/store/delete";
import { listVersions, readVersion, versionIdSchema } from "@/lib/career/store/history";
import { loadCareerProfile, restoreCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { logActionFailure } from "@/lib/logging/action-failure";
import { stringify } from "yaml";
import { getDb } from "@/lib/db";
import { failOpenControlRequests } from "@/lib/db/repos/control-requests";
import { CAREER_SCRUBBED_KINDS } from "@/lib/control/expire";
import { readCareerExtractStatus } from "@/lib/career/extract/request";
import { adoptDraft, adoptDecisionsSchema } from "@/lib/career/extract/adopt";
import { discardCareerDraft, draftIdSchema, listPendingCareerDrafts, readCareerDraft } from "@/lib/career/extract/draft-store";

const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const profileInput = z.strictObject({ profile: careerProfileSchema, baseHash: hash });
const contactInput = z.strictObject({ contact: careerContactSchema, baseHash: hash });
const restoreInput = z.strictObject({ version: versionIdSchema, baseHash: hash });
const deleteInput = z.strictObject({ confirmed: z.literal(true), kind: z.enum(["history", "all"]) });

function failure(action: string, error: unknown) {
  logActionFailure(action, error);
  return { ok: false as const, code: error instanceof CareerStoreError ? error.code : "write_failed" };
}

export async function saveProfileAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = profileInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "profile_invalid" };
  try {
    return await saveCareerProfile(profileContent(parsed.data.profile), { baseHash: parsed.data.baseHash });
  } catch (error) {
    return failure("saveCareerProfile", error);
  }
}

export async function saveContactAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = contactInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "contact_invalid" };
  try {
    return await saveContact(parsed.data.contact, { baseHash: parsed.data.baseHash });
  } catch (error) {
    return failure("saveCareerContact", error);
  }
}

export async function historyAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  if (!z.strictObject({}).safeParse(input).success) return { ok: false as const, code: "history_invalid" };
  try {
    return { ok: true as const, versions: await listVersions() };
  } catch (error) {
    return failure("careerHistory", error);
  }
}

export async function diffVersionAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = z.strictObject({ version: versionIdSchema }).safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "version_missing" };
  try {
    const version = await readVersion(parsed.data.version);
    const current = await loadCareerProfile();
    return {
      ok: true as const,
      changes: diffLines(stringify(profileContent(version)), stringify(profileContent(current.profile))).map(({ added, removed, value }) => ({
        added: !!added,
        removed: !!removed,
        value,
      })),
    };
  } catch (error) {
    return failure("careerVersionDiff", error);
  }
}

export async function restoreVersionAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = restoreInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "history_invalid" };
  try {
    return await restoreCareerProfile(await readVersion(parsed.data.version), { baseHash: parsed.data.baseHash });
  } catch (error) {
    return failure("restoreCareerVersion", error);
  }
}

export async function deleteCareerAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = deleteInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "confirmation_required" };
  try {
    if (parsed.data.kind === "history") await clearCareerHistory();
    else await deleteCareerData(async () => { await failOpenControlRequests(getDb(), CAREER_SCRUBBED_KINDS, "deleted"); });
    return { ok: true as const };
  } catch (error) {
    return failure("deleteCareerData", error);
  }
}

export async function getCareerExtractStatus(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = z.strictObject({ requestId: draftIdSchema.optional() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "invalid_payload" };
  try { return { ok: true as const, status: await readCareerExtractStatus(getDb(), parsed.data.requestId) }; }
  catch (error) { return failure("careerExtractStatus", error); }
}

export async function listCareerDrafts(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  if (!z.strictObject({}).safeParse(input).success) return { ok: false as const, code: "draft_invalid" };
  try { return { ok: true as const, drafts: await listPendingCareerDrafts() }; }
  catch (error) { return failure("listCareerDrafts", error); }
}

export async function readCareerDraftAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = z.strictObject({ requestId: draftIdSchema }).safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "draft_invalid" };
  try {
    await listPendingCareerDrafts();
    return { ok: true as const, draft: await readCareerDraft(parsed.data.requestId) };
  } catch (error) { return failure("readCareerDraft", error); }
}

export async function adoptCareerDraftAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = z.strictObject({ requestId: draftIdSchema, baseHash: hash, decisions: adoptDecisionsSchema }).safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "draft_invalid" };
  try {
    const draft = await readCareerDraft(parsed.data.requestId);
    const current = await loadCareerProfile();
    const saved = await saveCareerProfile(adoptDraft(current.profile, draft, parsed.data.decisions), { baseHash: parsed.data.baseHash });
    if (saved.ok) {
      try {
        await discardCareerDraft(parsed.data.requestId);
        return { ...saved, draftDiscarded: true };
      } catch (error) {
        logActionFailure("discardAdoptedCareerDraft", error);
        return { ...saved, draftDiscarded: false };
      }
    }
    return saved;
  } catch (error) { return failure("adoptCareerDraft", error); }
}

export async function discardCareerDraftAction(input: unknown) {
  if (!(await readCareerGate()).enabled) return { ok: false as const, code: "disabled" };
  const parsed = z.strictObject({ requestId: draftIdSchema }).safeParse(input);
  if (!parsed.success) return { ok: false as const, code: "draft_invalid" };
  try { await discardCareerDraft(parsed.data.requestId); return { ok: true as const }; }
  catch (error) { return failure("discardCareerDraft", error); }
}
