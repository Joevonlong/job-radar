"use server";

import { revalidatePath } from "next/cache";
import { previewDelete, executeDelete, type PreviewDeleteResult, type ExecuteDeleteResult } from "@/lib/activity/manage";
import { getDb } from "@/lib/db";
import { logActionFailure } from "@/lib/logging/action-failure";

export async function previewActivityDeleteAction(payload: unknown): Promise<PreviewDeleteResult | { status: "failed" }> {
  try { return await previewDelete(getDb(), payload); }
  catch (error) { logActionFailure("previewActivityDelete", error); return { status: "failed" }; }
}

export async function executeActivityDeleteAction(payload: unknown): Promise<ExecuteDeleteResult | { status: "failed" }> {
  try {
    const result = await executeDelete(getDb(), payload);
    // A partial batch can remove only child spans, which are not included in the returned counters.
    if (result.status === "partial" || (result.status === "done" && (result.roots > 0 || result.events > 0))) revalidatePath("/sources/logs");
    return result;
  } catch (error) { logActionFailure("executeActivityDelete", error); return { status: "failed" }; }
}
