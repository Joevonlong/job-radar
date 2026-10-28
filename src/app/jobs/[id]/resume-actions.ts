"use server";

import { logActionFailure } from "@/lib/logging/action-failure";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { getDb, jobExists, setApplicationResumePath, type ApplicationStatus } from "@/lib/db";
import { readResumeConfig } from "@/lib/resume/config";
import { prepareResumeKit } from "@/lib/resume/export";
import { resolveAllowedPdf } from "@/lib/resume/paths";
import { pdfDisplayName, type PdfPathError } from "@/lib/resume/types";

/**
 * Server Actions of the resume-kit hand-off: export the JD, attach / detach the tailored PDF.
 * The app is single-user and bound to loopback (C5); input is still validated (C6), and a PDF path is
 * only accepted inside `config/resume.yaml: pdf_dir` (see `resolveAllowedPdf`).
 */

const jobIdSchema = z.number().int().positive();
const exportInputSchema = z.object({ jobId: jobIdSchema });
const attachInputSchema = z.object({ jobId: jobIdSchema, path: z.string().max(1024) });

export type ExportResumeResult =
  | {
      ok: true;
      /** Path of the exported file as the user's shell sees it. */
      jdPath: string;
      /** The `/tailor` command to paste; null while `resume_kit_path` is not configured. */
      command: string | null;
      /** Application status after the export (it stays when the job is already further along). */
      status: ApplicationStatus;
      /** The export moved the application to `preparing`. */
      statusChanged: boolean;
    }
  | { ok: false; error: "invalid" | "not_found" | "config" | "write_failed" | "failed" };

export type AttachResumeResult =
  | { ok: true; path: string; name: string }
  | { ok: false; error: "invalid" | "not_found" | "config" | "failed" | PdfPathError };

export type DetachResumeResult = { ok: true } | { ok: false; error: "invalid" | "not_found" | "failed" };

function refreshViews(): void {
  revalidatePath("/", "layout");
}

/** The "定制简历" button: JD file + `preparing` + the command. */
export async function exportResumeKitAction(input: { jobId: number }): Promise<ExportResumeResult> {
  const parsed = exportInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const config = readResumeConfig();
  if (config === null) return { ok: false, error: "config" };
  try {
    const result = await prepareResumeKit(getDb(), parsed.data.jobId, { config, timeZone: loadConfig("schedule").timezone, source: "web" });
    if (!result.ok) return { ok: false, error: result.error };
    refreshViews();
    const { statusChange } = result;
    return { ok: true, jdPath: result.jdPath, command: result.command, status: statusChange.rejected ? (statusChange.previous ?? "new") : statusChange.status, statusChanged: statusChange.changed };
  } catch (error) {
    logActionFailure("exportResumeKitAction", error);
    return { ok: false, error: "failed" };
  }
}

/** "挂上简历": store a PDF of the configured directory in `applications.resume_variant_path`. */
export async function attachResumePdfAction(input: { jobId: number; path: string }): Promise<AttachResumeResult> {
  const parsed = attachInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const config = readResumeConfig();
  if (config === null) return { ok: false, error: "config" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    const pdf = await resolveAllowedPdf(parsed.data.path, config.pdf_dir);
    if (!pdf.ok) return { ok: false, error: pdf.error };
    await setApplicationResumePath(db, parsed.data.jobId, pdf.path);
    refreshViews();
    return { ok: true, path: pdf.path, name: pdfDisplayName(pdf.path) };
  } catch (error) {
    logActionFailure("attachResumePdfAction", error);
    return { ok: false, error: "failed" };
  }
}

/** Remove the attached PDF from the application (the file itself is never touched). */
export async function detachResumePdfAction(input: { jobId: number }): Promise<DetachResumeResult> {
  const parsed = exportInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const db = getDb();
    if (!(await jobExists(db, parsed.data.jobId))) return { ok: false, error: "not_found" };
    await setApplicationResumePath(db, parsed.data.jobId, null);
    refreshViews();
    return { ok: true };
  } catch (error) {
    logActionFailure("detachResumePdfAction", error);
    return { ok: false, error: "failed" };
  }
}
