"use server";

import { revalidatePath } from "next/cache";

import { addBoardCandidate, dismissBoardCandidate, type CandidateActionState } from "@/lib/sources/candidates";

// Server Actions are public POST endpoints: everything arriving here is validated again in the
// service (zod), and the web server only listens on 127.0.0.1 / Tailscale (C5).

export async function addBoardCandidateAction(payload: unknown): Promise<CandidateActionState> {
  const result = await addBoardCandidate(payload);
  if (result.status === "done") {
    revalidatePath("/sources");
    revalidatePath("/sources/registry");
  }
  return result;
}

export async function dismissBoardCandidateAction(payload: unknown): Promise<CandidateActionState> {
  const result = await dismissBoardCandidate(payload);
  if (result.status === "done") {
    revalidatePath("/sources");
    revalidatePath("/sources/registry");
  }
  return result;
}
