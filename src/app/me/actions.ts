"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { readStoryExtractRequest, type StoryExtractErrorCode } from "@/lib/control/story-extract-request";
import { getDb } from "@/lib/db";
import { discardStoryDraft } from "@/lib/db/repos/story-drafts";
import { loadMarket } from "@/lib/market";
import { previewPersonalDealBreakers, previewRequestSchema, type DraftPreviewRule } from "@/lib/profile/deal-breaker-preview";
import { invalidProfileRequest, rollbackProfile, saveProfile, saveStories } from "@/lib/profile/service";
import { enableMarketChannels, type RegistryActionState } from "@/lib/sources/registry/service";
import type { ProfileActionState } from "@/lib/profile/types";
import { adoptStoryDraft } from "@/lib/stories/adopt";
import { adoptedStorySchema } from "@/lib/stories/extract";

// Server Actions are public POST endpoints: everything arriving here is validated again in the
// service (zod), and the web server only listens on 127.0.0.1 / Tailscale.

async function refreshed(result: ProfileActionState): Promise<ProfileActionState> {
  // stale: the file changed elsewhere; the page reloads with the saved values (the form remounts and shows the message)
  if (result.status === "saved" || (result.status === "error" && result.formError === "stale")) revalidatePath("/me");
  return result;
}

/**
 * `{ draft, baseHash }` from the form; `draft` is validated again in the service. `baseHash` is required here: the
 * form always sends it, and a save without one could overwrite a file changed elsewhere (only the setup wizard saves
 * without it, through the service directly).
 */
const saveRequestSchema = z.object({ draft: z.unknown(), baseHash: z.string().max(200) });

async function saveFromForm(kind: "me" | "preferences", request: unknown): Promise<ProfileActionState> {
  const parsed = saveRequestSchema.safeParse(request);
  if (!parsed.success) return invalidProfileRequest(kind);
  return refreshed(await saveProfile(kind, parsed.data.draft, parsed.data.baseHash));
}

export async function saveMeAction(_prev: ProfileActionState, request: unknown): Promise<ProfileActionState> {
  return saveFromForm("me", request);
}

export async function savePreferencesAction(_prev: ProfileActionState, request: unknown): Promise<ProfileActionState> {
  return saveFromForm("preferences", request);
}

/** The experience library: `{ draft, baseHash }` like the other forms. */
export async function saveStoriesAction(_prev: ProfileActionState, request: unknown): Promise<ProfileActionState> {
  const parsed = saveRequestSchema.safeParse(request);
  if (!parsed.success) return invalidProfileRequest("stories");
  return refreshed(await saveStories(parsed.data.draft, parsed.data.baseHash));
}

export async function rollbackAction(_prev: ProfileActionState, request: unknown): Promise<ProfileActionState> {
  return refreshed(await rollbackProfile(request));
}

/** Switch on the current market's own job boards (the pack's `default_channels`, read here, not from the browser). */
export async function enableMarketChannelsAction(): Promise<RegistryActionState> {
  let ids: readonly string[];
  try {
    ids = loadMarket().defaultChannels;
  } catch (error) {
    logActionFailure("enableMarketChannelsAction", error);
    return { status: "error", error: "config_invalid" };
  }
  const result = await enableMarketChannels(ids);
  if (result.status === "done") {
    revalidatePath("/me");
    revalidatePath("/sources");
    revalidatePath("/sources/registry");
  }
  return result;
}

export type DealBreakerPreviewResult = { status: "done"; total: number; partial: boolean; rules: DraftPreviewRule[] } | { status: "error"; error: "invalid" | "unavailable" };

/** What the form's deal-breakers (drafts, not saved) would veto among the jobs in the database now; nothing is written. */
export async function previewDealBreakersAction(drafts: unknown): Promise<DealBreakerPreviewResult> {
  const parsed = previewRequestSchema.safeParse(drafts);
  if (!parsed.success) return { status: "error", error: "invalid" };
  try {
    const preview = await previewPersonalDealBreakers(getDb(), parsed.data);
    return { status: "done", ...preview };
  } catch (error) {
    logActionFailure("previewDealBreakersAction", error);
    // no database, or pipeline.yaml / the market cannot be read: the card says the preview is unavailable
    return { status: "error", error: "unavailable" };
  }
}

const positiveId = z.number().int().positive();

export type StoryExtractStatusResult =
  | { ok: true; state: "waiting"; stage: "pending" | "running"; queue: unknown }
  | { ok: true; state: "done"; drafts: number }
  | { ok: false; error: StoryExtractErrorCode | "not_found" | "invalid"; resumeAt: string | null }
  | null;

/** Where an extraction stands; `null`: it could not be read this time. Its end refreshes the page, which lists the new drafts. */
export async function storyExtractStatusAction(requestId: unknown): Promise<StoryExtractStatusResult> {
  const parsed = positiveId.safeParse(requestId);
  if (!parsed.success) return { ok: false, error: "invalid", resumeAt: null };
  try {
    const state = await readStoryExtractRequest(getDb(), parsed.data);
    if (state.state === "missing") return { ok: false, error: "not_found", resumeAt: null };
    if (state.state === "waiting") return { ok: true, state: "waiting", stage: state.stage, queue: state.queue };
    if (state.state === "failed") return { ok: false, error: state.error, resumeAt: state.resumeAt };
    revalidatePath("/me");
    return { ok: true, state: "done", drafts: state.drafts };
  } catch (error) {
    logActionFailure("storyExtractStatusAction", error);
    return null;
  }
}

export type AdoptStoryDraftResult = { status: "saved" } | { status: "not_found" | "unreadable" | "invalid" | "failed" } | { status: "refused"; result: ProfileActionState };

const adoptRequestSchema = z.strictObject({ draftId: positiveId, baseHash: z.string().max(200), edited: adoptedStorySchema.optional() });

/** Adopt a draft into the experience library, with your edits if any. */
export async function adoptStoryDraftAction(request: unknown): Promise<AdoptStoryDraftResult> {
  const parsed = adoptRequestSchema.safeParse(request);
  if (!parsed.success) return { status: "invalid" };
  try {
    const outcome = await adoptStoryDraft(getDb(), parsed.data);
    if (outcome.state === "saved") {
      revalidatePath("/me");
      return { status: "saved" };
    }
    if (outcome.state === "refused") {
      await refreshed(outcome.result);
      return { status: "refused", result: outcome.result };
    }
    return { status: outcome.state };
  } catch (error) {
    logActionFailure("adoptStoryDraftAction", error);
    return { status: "failed" };
  }
}

/** Discard a draft; its text goes with it. */
export async function discardStoryDraftAction(draftId: unknown): Promise<{ ok: boolean }> {
  const parsed = positiveId.safeParse(draftId);
  if (!parsed.success) return { ok: false };
  try {
    const ok = await discardStoryDraft(getDb(), parsed.data);
    revalidatePath("/me");
    return { ok };
  } catch (error) {
    logActionFailure("discardStoryDraftAction", error);
    return { ok: false };
  }
}
