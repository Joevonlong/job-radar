"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { currentMe } from "@/lib/filter";
import { loadMarket, loadPipeline } from "@/lib/market";
import { previewDealBreakerDrafts, previewRequestSchema, type DraftPreviewRule } from "@/lib/profile/deal-breaker-preview";
import { invalidProfileRequest, rollbackProfile, saveProfile } from "@/lib/profile/service";
import { syncSearchLocations, type SyncSearchLocationsResult } from "@/lib/profile/search-locations";
import { enableMarketChannels, type RegistryActionState } from "@/lib/sources/registry/service";
import type { ProfileName } from "@/lib/config";
import type { ProfileActionState } from "@/lib/profile/types";

// Server Actions are public POST endpoints: everything arriving here is validated again in the
// service (zod), and the web server only listens on 127.0.0.1 / Tailscale (C5).

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

async function saveFromForm(kind: ProfileName, request: unknown): Promise<ProfileActionState> {
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

/** Copy the places of "What I want" into search.yaml `locations` (the cities that are searched). */
export async function syncSearchLocationsAction(locations: unknown): Promise<SyncSearchLocationsResult> {
  const result = await syncSearchLocations(locations);
  if (result.status === "done") {
    revalidatePath("/me");
    revalidatePath("/settings");
  }
  return result;
}

/** Examples per rule in the form's preview. */
const PREVIEW_SAMPLES = 3;

export type DealBreakerPreviewResult = { status: "done"; total: number; partial: boolean; rules: DraftPreviewRule[] } | { status: "error"; error: "invalid" | "unavailable" };

/** What the form's deal-breakers (drafts, not saved) would veto among the jobs in the database now; nothing is written. */
export async function previewDealBreakersAction(drafts: unknown): Promise<DealBreakerPreviewResult> {
  const parsed = previewRequestSchema.safeParse(drafts);
  if (!parsed.success) return { status: "error", error: "invalid" };
  try {
    const preview = await previewDealBreakerDrafts(getDb(), parsed.data, { pipeline: loadPipeline(), me: currentMe(), sampleLimit: PREVIEW_SAMPLES });
    return { status: "done", ...preview };
  } catch (error) {
    logActionFailure("previewDealBreakersAction", error);
    // no database, or pipeline.yaml / the market cannot be read: the card says the preview is unavailable
    return { status: "error", error: "unavailable" };
  }
}
