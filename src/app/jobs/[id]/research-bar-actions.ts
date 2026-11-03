"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { readBreakdownSettings } from "@/lib/breakdown/settings";
import { reloadConfig, type AiConfig } from "@/lib/config";
import { RESEARCH_ITEMS, type ResearchItem } from "@/lib/config/schemas/research";
import { requestBreakdownJob } from "@/lib/control/breakdown-request";
import { requestCompanyResearch } from "@/lib/control/company-research-request";
import { requestSalaryLookup } from "@/lib/control/salary-request";
import { getDb } from "@/lib/db";
import { logActionFailure } from "@/lib/logging/action-failure";
import { getResearchBarStatus, type ResearchBarStatus } from "@/lib/research/bar";
import { readResearchSettings } from "@/lib/research/settings";
import { readSalarySettings } from "@/lib/salary/settings";

/**
 * Server Actions of the research bar. Pressed by hand, so these use the manual limits and the interactive lane; an automatic
 * request waiting for the same thing moves up. The ai-worker does the work; the bar polls `researchStatusAction`.
 */

const jobIdSchema = z.number().int().positive();
const itemInputSchema = z.object({ jobId: jobIdSchema, item: z.enum(RESEARCH_ITEMS) });

export type ResearchActionResult = { ok: true; status: ResearchBarStatus | null; errors: Partial<Record<ResearchItem, string>> } | { ok: false; error: "invalid" | "disabled" | "failed" };

function readAi(): AiConfig | null {
  try {
    return reloadConfig("ai");
  } catch {
    return null;
  }
}

async function readStatus(jobId: number): Promise<ResearchBarStatus | null> {
  const research = readResearchSettings();
  return getResearchBarStatus(getDb(), { jobId, research: research.state === "ok" ? research.config : null, ai: readAi(), salary: readSalarySettings(), breakdown: readBreakdownSettings(), now: new Date() });
}

async function requestItem(jobId: number, item: ResearchItem, force: boolean): Promise<string | null> {
  const db = getDb();
  const ai = readAi();
  let outcome: { state: "cached" | "queued" } | { state: "error"; error: string };
  if (item === "company") {
    const research = readResearchSettings();
    outcome = await requestCompanyResearch(db, { jobId, force, research: research.state === "ok" ? research.config : null, ai });
  } else if (item === "breakdown") {
    outcome = await requestBreakdownJob(db, { jobId, force, settings: readBreakdownSettings() });
  } else {
    const salary = readSalarySettings();
    outcome = await requestSalaryLookup(db, { jobId, force, salary: salary.state === "ok" ? salary.config : null, ai });
  }
  return outcome.state === "error" ? outcome.error : null;
}

async function request(jobId: number, items: readonly ResearchItem[], force: boolean): Promise<ResearchActionResult> {
  const research = readResearchSettings();
  if (research.state !== "ok" || !research.config.enabled) return { ok: false, error: "disabled" };
  const errors: Partial<Record<ResearchItem, string>> = {};
  for (const item of items) {
    const error = await requestItem(jobId, item, force);
    if (error) errors[item] = error;
  }
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, status: await readStatus(jobId), errors };
}

/** "Research all": asks for each part that has nothing current; what is cached stays as it is. */
export async function requestResearchAction(jobId: number): Promise<ResearchActionResult> {
  const parsed = jobIdSchema.safeParse(jobId);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const status = await readStatus(parsed.data);
    // a part that is off stays off: the bar links to its settings
    const items = RESEARCH_ITEMS.filter((item) => {
      const state = status?.items[item]?.state;
      return state !== "off" && state !== "unavailable" && state !== "running";
    });
    return await request(parsed.data, items, false);
  } catch (error) {
    logActionFailure("requestResearchAction", error);
    return { ok: false, error: "failed" };
  }
}

/** One part, on purpose: runs again even when a current result exists. */
export async function requestResearchItemAction(input: { jobId: number; item: ResearchItem }): Promise<ResearchActionResult> {
  const parsed = itemInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    return await request(parsed.data.jobId, [parsed.data.item], true);
  } catch (error) {
    logActionFailure("requestResearchItemAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Where the parts stand; null when it could not be read this time (the bar retries). */
export async function researchStatusAction(jobId: number): Promise<{ status: ResearchBarStatus | null } | null> {
  const parsed = jobIdSchema.safeParse(jobId);
  if (!parsed.success) return null;
  try {
    return { status: await readStatus(parsed.data) };
  } catch (error) {
    logActionFailure("researchStatusAction", error);
    return null;
  }
}
