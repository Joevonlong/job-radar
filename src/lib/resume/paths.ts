import fs from "node:fs/promises";
import path from "node:path";

import { getDataRoot } from "@/lib/config/paths";

import type { PdfPathError } from "./types";

/**
 * Paths of the resume-kit hand-off. Two jobs: build safe export file names, and decide
 * whether a PDF path typed by the user may be attached to an application. The second one is a
 * security boundary: the input is untrusted text from the browser and must never reach outside the
 * configured PDF directory (`..` segments, absolute paths elsewhere, symlinks that point out).
 */

// ---------------------------------------------------------------- export file names

/** Lower-case ASCII slug: accents folded, everything else collapsed to single dashes. Empty when nothing is left. */
export function slugify(text: string, maxChars: number): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxChars).replace(/-+$/g, "");
}

/** `yyyy-mm-dd` of `date` in `timeZone` (the day the user sees, not the UTC day). */
export function isoDateIn(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export interface ExportFileNameInput {
  company: string;
  title: string;
  /** `yyyy-mm-dd`. */
  date: string;
  maxPartChars: number;
  /** Appended when another job already owns the plain name (two postings of one company and title on one day). */
  jobIdSuffix?: number;
}

/** `<company>-<title>-<date>.md`; a part that has no usable characters (e.g. a Chinese title) becomes `untitled`. */
export function exportFileName(input: ExportFileNameInput): string {
  const company = slugify(input.company, input.maxPartChars) || "untitled";
  const title = slugify(input.title, input.maxPartChars) || "untitled";
  const suffix = input.jobIdSuffix === undefined ? "" : `-${input.jobIdSuffix}`;
  return `${company}-${title}-${input.date}${suffix}.md`;
}

/** The export directory as the app process sees it (relative values resolve against the data root, `getDataRoot`). */
export function resolveExportDir(configured: string): string {
  return path.resolve(getDataRoot(), configured);
}

// ---------------------------------------------------------------- attaching a PDF

export type PdfPathResult = { ok: true; path: string } | { ok: false; error: PdfPathError };

/** Longest accepted input; real paths are far shorter, the cap only stops absurd payloads. */
const MAX_INPUT_CHARS = 1024;

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Check a PDF path from the browser against the allowed directory.
 *
 * - a relative input is read as relative to `allowedDir` (the user may type just the file name);
 * - the lexical check (`..` removed, must stay inside) runs before the disk is touched, so a path outside
 *   gets the same answer whether or not it exists there;
 * - the real path (symlinks resolved) must stay inside the real allowed directory too;
 * - the target must be an existing regular file ending in `.pdf`.
 *
 * Returns the resolved absolute path (what is stored in `applications.resume_variant_path`).
 */
export async function resolveAllowedPdf(input: string, allowedDir: string | null): Promise<PdfPathResult> {
  if (allowedDir === null) return { ok: false, error: "not_configured" };
  const text = input.trim();
  if (text === "" || text.length > MAX_INPUT_CHARS || text.includes("\0")) return { ok: false, error: "invalid" };

  const root = path.resolve(allowedDir);
  const candidate = path.resolve(root, text);
  if (!isInside(root, candidate)) return { ok: false, error: "outside" };
  if (path.extname(candidate).toLowerCase() !== ".pdf") return { ok: false, error: "not_pdf" };

  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await fs.realpath(root);
    realCandidate = await fs.realpath(candidate);
  } catch {
    return { ok: false, error: "not_found" };
  }
  if (!isInside(realRoot, realCandidate)) return { ok: false, error: "outside" };
  try {
    const stat = await fs.stat(realCandidate);
    if (!stat.isFile()) return { ok: false, error: "not_found" };
  } catch {
    return { ok: false, error: "not_found" };
  }
  return { ok: true, path: candidate };
}

export interface PdfOption {
  /** File name, relative to the allowed directory (what the select submits). */
  name: string;
}

/** PDFs directly inside the allowed directory, newest first. Empty when the directory is missing or unreadable. */
export async function listPdfs(allowedDir: string | null, limit: number): Promise<PdfOption[]> {
  if (allowedDir === null) return [];
  try {
    const root = path.resolve(allowedDir);
    const entries = await fs.readdir(root, { withFileTypes: true });
    const withTime: Array<{ name: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".pdf") continue;
      try {
        const stat = await fs.stat(path.join(root, entry.name));
        withTime.push({ name: entry.name, mtime: stat.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
    withTime.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    return withTime.slice(0, limit).map(({ name }) => ({ name }));
  } catch {
    return [];
  }
}
