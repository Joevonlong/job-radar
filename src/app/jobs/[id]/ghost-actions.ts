"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { clearGhostDismissed, getDb, jobExists, setGhostDismissed } from "@/lib/db";
import { ghostEnabled } from "@/lib/ghost/settings";

/**
 * Server Action of "Not a ghost job" / "Undo" on the detail page's checks card. The dismissal keeps the reason codes the job has
 * now (`job_ghost.dismissed_codes`): the mark stays away until a new kind of reason comes up. Nothing else changes (C3). The app is
 * single-user and bound to loopback (C5); input is still validated (C6).
 */

const inputSchema = z.object({
  jobId: z.number().int().positive(),
  /** `clear` takes the dismissal back. */
  action: z.enum(["dismiss", "clear"]),
});

export type GhostDismissResult = { ok: true; changed: boolean } | { ok: false; error: "invalid" | "not_found" | "disabled" | "failed" };

export async function setGhostDismissAction(input: { jobId: number; action: string }): Promise<GhostDismissResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  if (!ghostEnabled()) return { ok: false, error: "disabled" };
  const { jobId, action } = parsed.data;
  try {
    const db = getDb();
    if (!(await jobExists(db, jobId))) return { ok: false, error: "not_found" };
    const changed = action === "dismiss" ? await setGhostDismissed(db, jobId) : await clearGhostDismissed(db, jobId);
    revalidatePath("/", "layout");
    return { ok: true, changed };
  } catch (error) {
    logActionFailure("setGhostDismissAction", error);
    return { ok: false, error: "failed" };
  }
}
