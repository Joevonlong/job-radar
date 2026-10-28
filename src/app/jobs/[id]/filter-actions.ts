"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createProcessLogger } from "@/lib/logging/process-logger";
import { clearFilterOverride, getDb, jobExists, setFilterOverride } from "@/lib/db";
import { refilterJob } from "@/lib/filter";

/**
 * Server Action of the "keep anyway / exclude" buttons on the detail page. The decision is stored per
 * job (`job_filter_overrides`), so it survives re-filtering and new preference snapshots, and the job's
 * filter result is recomputed right away. The app is single-user and bound to loopback (C5); input is
 * still validated (C6).
 */

const inputSchema = z.object({
  jobId: z.number().int().positive(),
  /** `clear` takes the decision back: the rules decide again. */
  action: z.enum(["keep", "exclude", "clear"]),
});

export type FilterOverrideResult =
  | { ok: true; filterResult: "passed" | "filtered_out" | null }
  | { ok: false; error: "invalid" | "not_found" | "failed" };

export async function setFilterOverrideAction(input: { jobId: number; action: string }): Promise<FilterOverrideResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { jobId, action } = parsed.data;
  try {
    const db = getDb();
    if (!(await jobExists(db, jobId))) return { ok: false, error: "not_found" };
    if (action === "clear") await clearFilterOverride(db, jobId);
    else await setFilterOverride(db, jobId, action);
    const result = await refilterJob(db, jobId, createProcessLogger());
    revalidatePath("/", "layout");
    return { ok: true, filterResult: result?.filterResult ?? null };
  } catch (error) {
    logActionFailure("setFilterOverrideAction", error);
    return { ok: false, error: "failed" };
  }
}
