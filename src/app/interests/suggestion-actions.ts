"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";

import { getDb } from "@/lib/db";
import { approveSuggestion, rejectSuggestion } from "@/lib/interests/suggestion-apply";
import { enqueueSuggestRequest } from "@/lib/interests/suggest-schedule";
import type { SuggestionActionState, SuggestRunState } from "@/lib/interests/suggestion-types";

// Server Actions are public POST endpoints: everything arriving here is validated again in the services (zod),
// and the web server only listens on 127.0.0.1 / Tailscale (C5).

/** Pages that show the interests lists or the ranking. */
function refresh(state: SuggestionActionState): SuggestionActionState {
  if (state.status === "approved" || state.status === "rejected") {
    revalidatePath("/interests");
    if (state.status === "approved") {
      revalidatePath("/");
      revalidatePath("/jobs");
    }
  }
  return state;
}

export async function approveSuggestionAction(id: unknown): Promise<SuggestionActionState> {
  return refresh(await approveSuggestion(id));
}

export async function rejectSuggestionAction(id: unknown): Promise<SuggestionActionState> {
  return refresh(await rejectSuggestion(id));
}

/** "Look for suggestions now": leave a `run_suggest` request for whoever runs AI. */
export async function requestSuggestRunAction(): Promise<SuggestRunState> {
  try {
    const { id, existing } = await enqueueSuggestRequest(getDb());
    revalidatePath("/interests");
    return { status: "queued", request: id, existing, nonce: Date.now() };
  } catch (error) {
    logActionFailure("requestSuggestRunAction", error);
    return { status: "error", error: "databaseUnavailable", nonce: Date.now() };
  }
}
