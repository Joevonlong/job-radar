import type { ResumeConfig } from "@/lib/config/schemas/resume";

/**
 * The shell command that starts the `/tailor` skill of resume-kit (its SKILL.md takes a posting file
 * and asks for anything missing; the master resume and the PDF folder are passed as plain words).
 * Pure, so it is tested without a disk.
 */

const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Characters that stay literal inside shell double quotes unless escaped: $ ` \ " ! */
const DOUBLE_QUOTE_UNSAFE = /[$`\\"!\n\r]/;

/** One shell word: left bare when it is plain, in double quotes when that is safe, else in single quotes. */
export function shellQuote(value: string): string {
  if (value !== "" && BARE.test(value)) return value;
  if (!DOUBLE_QUOTE_UNSAFE.test(value) && !value.includes("'")) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface TailorCommandInput {
  config: Pick<ResumeConfig, "resume_kit_path" | "master_resume_path" | "pdf_dir" | "claude_command" | "claude_args">;
  /** The exported JD as the shell sees it. */
  jdPath: string;
}

/** A path in the prompt: quoted when it has spaces, so the skill reads it as one value. */
function promptPath(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The prompt given to Claude Code: `/tailor <jd>`, plus `master-resume=<path>` and `exports-folder=<path>`
 * when configured (the skill asks for any input it is not given; `key=value` keeps a path from running
 * into the words around it).
 */
export function tailorPrompt({ config, jdPath }: TailorCommandInput): string {
  const parts = [`/tailor ${promptPath(jdPath)}`];
  if (config.master_resume_path !== null) parts.push(`master-resume=${promptPath(config.master_resume_path)}`);
  if (config.pdf_dir !== null) parts.push(`exports-folder=${promptPath(config.pdf_dir)}`);
  return parts.join(" ");
}

/**
 * `cd <resume-kit> && claude <claude_args> "/tailor <jd>"`, or null while `resume_kit_path` is not configured.
 * The prompt is one shell word, so a path with spaces stays one argument.
 */
export function buildTailorCommand(input: TailorCommandInput): string | null {
  const kit = input.config.resume_kit_path;
  if (kit === null) return null;
  const args = input.config.claude_args.trim();
  return `cd ${shellQuote(kit)} && ${input.config.claude_command}${args === "" ? "" : ` ${args}`} ${shellQuote(tailorPrompt(input))}`;
}
