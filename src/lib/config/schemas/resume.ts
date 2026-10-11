import path from "node:path";

import { z } from "zod";

import { nonEmptyString, positiveInt } from "./common";

/** An absolute filesystem path (no `~`, no relative parts): the commands built from it are pasted into a shell. */
const absolutePath = nonEmptyString.refine((value) => path.isAbsolute(value), "must be an absolute path");

/** An absolute path, or one relative to the app root (the project directory). */
const appPath = nonEmptyString;

/**
 * config/resume.yaml — the resume-kit hand-off. The paths point at the
 * user's own files, which live outside this repository (C4: the master resume is never read here).
 */
export const resumeSchema = z.strictObject({
  /** Checkout of resume-kit; the `/tailor` command is run there. null: the panel shows the export path only. */
  resume_kit_path: absolutePath.nullable(),
  /** The user's master resume YAML (outside this repo). Only named in the command, never read. null: not mentioned. */
  master_resume_path: absolutePath.nullable(),
  /** Directory the tailored PDFs live in; the only place a PDF can be attached from. null: attaching is switched off. */
  pdf_dir: absolutePath.nullable(),
  /** Where the exported JDs are written (`<company>-<title>-<date>.md`). Relative values resolve against the app root. */
  jd_export_dir: appPath,
  /** The same directory as the host sees it, for the pasted command; only needed when the app runs in a container. null: same as above. */
  jd_export_host_dir: absolutePath.nullable(),
  /** The Claude Code CLI as typed in a shell. */
  claude_command: nonEmptyString,
  /**
   * Extra options typed after `claude_command` in the pasted command. The exported posting is untrusted third-party text read by
   * an interactive Claude Code session, so the default keeps the web tools off; add `Bash` to the list for the strictest
   * setting if your /tailor skill does not need it. Letters, digits and `_ = , . : / -` and spaces only (it is pasted unquoted).
   */
  claude_args: z
    .string()
    .regex(/^[A-Za-z0-9 _=,.:/-]*$/, "must only contain letters, digits and _ = , . : / - and spaces")
    .default("--disallowed-tools=WebFetch,WebSearch"),
  /** Longest company / title part of an export file name. */
  filename_part_max_chars: positiveInt,
  /** Longest verbatim signal quote written to the export's front matter. */
  signal_quote_max_chars: positiveInt,
  /** PDFs offered in the attach dialog (newest first). */
  pdf_list_limit: positiveInt,
});

export type ResumeConfig = z.infer<typeof resumeSchema>;
