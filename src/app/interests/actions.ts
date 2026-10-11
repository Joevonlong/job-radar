"use server";

import { revalidatePath } from "next/cache";

import {
  addWatchedCompany,
  deleteView,
  removeWatchedCompany,
  renameView,
  saveView,
  saveVocabulary,
  setDefaultView,
  suggestCompanyNames,
} from "@/lib/interests/service";
import { previewCategory, type CategoryPreview } from "@/lib/interests/preview";
import type { InterestsActionState } from "@/lib/interests/types";

// Server Actions are public POST endpoints: everything arriving here is validated again in the
// service (zod), and the web server only listens on 127.0.0.1 / Tailscale (C5).

/** Pages that show saved views or the ranking. */
function refresh(result: InterestsActionState): InterestsActionState {
  if (result.status === "saved") {
    revalidatePath("/interests");
    revalidatePath("/");
    revalidatePath("/jobs");
  }
  return result;
}

export async function saveVocabularyAction(draft: unknown): Promise<InterestsActionState> {
  return refresh(await saveVocabulary(draft));
}

export async function saveViewAction(request: unknown): Promise<InterestsActionState> {
  return refresh(await saveView(request));
}

export async function setDefaultViewAction(request: unknown): Promise<InterestsActionState> {
  return refresh(await setDefaultView(request));
}

export async function renameViewAction(request: unknown): Promise<InterestsActionState> {
  return refresh(await renameView(request));
}

export async function deleteViewAction(request: unknown): Promise<InterestsActionState> {
  return refresh(await deleteView(request));
}

export async function addWatchedCompanyAction(request: unknown): Promise<InterestsActionState> {
  return refresh(await addWatchedCompany(request));
}

export async function removeWatchedCompanyAction(request: unknown): Promise<InterestsActionState> {
  return refresh(await removeWatchedCompany(request));
}

export async function suggestCompaniesAction(query: unknown): Promise<string[]> {
  return suggestCompanyNames(query);
}

/** The rule stage of one draft category over recent jobs (read only, no AI). */
export async function previewCategoryAction(request: unknown): Promise<CategoryPreview> {
  return previewCategory(request);
}
