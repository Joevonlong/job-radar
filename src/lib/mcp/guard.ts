/**
 * The reader of an MCP result is an AI, the very target of the AI traps a posting may carry. Everything that comes from a posting
 * is treated as untrusted data: short fields lose invisible characters and are replaced as a whole by the trap marker when they
 * carry an instruction to an AI; the JD itself is given only after the stored trap findings were removed (`cleanDescriptionStrict`).
 */
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import { findPatternHits, instructionPatterns } from "@/lib/traps/instructions";
import { stripInvisible } from "@/lib/traps/unicode";

import type { CleanText, DescriptionDto } from "./dto";

/** Unicode tag characters (U+E0000-U+E007F): invisible, and able to spell out a hidden text. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

/**
 * The cleaner of short third-party fields (title, company, locations, salary text, signal quotes, links). Without readable trap
 * settings only the invisible characters go (no instruction patterns to look for).
 */
export function shortFieldCleaner(settings: TrapsConfig | null): CleanText {
  const patterns = settings ? instructionPatterns(settings) : [];
  const marker = settings?.ai_input.instruction_marker ?? null;
  return (text: string) => {
    const visible = stripInvisible(text).replace(TAG_CHARS, "");
    if (marker !== null && patterns.length > 0 && findPatternHits(visible, patterns).length > 0) return marker;
    return visible;
  };
}

/** A JD cut to `limit` characters (never inside a surrogate pair). */
export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

export function availableDescription(text: string | null, limit: number): DescriptionDto {
  if (text === null) return { available: true, text: null, truncated: false, total_chars: null, reason: null, message: null };
  const cut = truncateText(text, limit);
  return { available: true, text: cut.text, truncated: cut.truncated, total_chars: text.length, reason: null, message: null };
}

export function unavailableDescription(reason: string, message: string): DescriptionDto {
  return { available: false, text: null, truncated: false, total_chars: null, reason, message };
}

/** The structured result and its text form: the notices first, then the JSON (clients without structured output read the text). */
export function toolResult<T extends { notices: string[] }>(output: T): { content: Array<{ type: "text"; text: string }>; structuredContent: T } {
  const text = [...output.notices, JSON.stringify(output, null, 2)].join("\n\n");
  return { content: [{ type: "text", text }], structuredContent: output };
}

/** An error result: one line, a category only (no internal details, no paths, no addresses). */
export function errorResult(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}
