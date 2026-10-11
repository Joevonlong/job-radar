/** Vocabulary of the AI trap detection. Plain types and constants: the browser bundle imports them too. */
import type { HiddenMethod } from "@/lib/config/traps-options";

export { HIDDEN_METHODS, type HiddenMethod } from "@/lib/config/traps-options";

/** How a trap is made. `other` is a technique only the AI layer names (the rules know the others). */
export const TRAP_TECHNIQUES = ["hidden_text", "invisible_unicode", "html_comment", "attribute_text", "non_rendered", "instruction", "other"] as const;
export type TrapTechnique = (typeof TRAP_TECHNIQUES)[number];

/** `trap`: written to steer an AI (an instruction, decoded tag characters); `suspicious`: hidden, but nothing says it is aimed at an AI. */
export const TRAP_SEVERITIES = ["trap", "suspicious"] as const;
export type TrapSeverity = (typeof TRAP_SEVERITIES)[number];

/** Which layer found it. */
export const TRAP_LAYERS = ["rule", "ai"] as const;
export type TrapLayer = (typeof TRAP_LAYERS)[number];

/** What the AI layer said about a rule finding: confirmed, harmless, or (for a rule trap it cannot revoke) a different view. */
export const TRAP_AI_VERDICTS = ["confirmed", "benign", "disputed"] as const;
export type TrapAiVerdict = (typeof TRAP_AI_VERDICTS)[number];

/** Methods of the invisible-character technique. */
export const UNICODE_METHODS = ["tag_chars", "zero_width", "bidi_controls"] as const;
export type UnicodeMethod = (typeof UNICODE_METHODS)[number];

/** Methods of the non-rendered technique: the element whose text a converter took for body text. */
export const NON_RENDERED_TAGS = ["style", "script", "template", "noscript"] as const;

/** Every `method` value the rules write (the detail page names each). */
export type TrapMethod = HiddenMethod | UnicodeMethod | (typeof NON_RENDERED_TAGS)[number] | "comment" | "attribute";

/** An HTML part of a source posting (`Channel.descriptionHtml`): where it sits in the payload and the markup itself. */
export interface HtmlFragment {
  /** Field path in the payload, e.g. `posting.content`, `descriptionHtml`, `posting.lists[2].content`. */
  path: string;
  html: string;
  /** The markup is entity-escaped (Greenhouse `content`: `&lt;p&gt;`): unescaped before parsing. */
  escaped?: boolean;
}

/** What the rule scanners of one text or HTML fragment report, before it is placed in the JD. */
export interface RawFinding {
  technique: TrapTechnique;
  method: TrapMethod | null;
  severity: TrapSeverity;
  /** The text as found (hidden text, the comment, the attribute value, the instruction sentence). Never empty. */
  text: string;
  /** Where in the fragment: the field path, plus `@alt` for an attribute or `#comment` for a comment. */
  path: string;
  /** Offset of `text` when it was found in the text that was scanned (scanText); null for HTML findings. */
  offset: number | null;
  /** The markup that hides it (`style="color:#ffffff"`); at most 200 characters. */
  evidence: string | null;
  /** Id of the instruction pattern (traps.yaml `instructions[].id`) the text matched; null when none. */
  instructionId: string | null;
  /** Extra facts: the decoded text of tag characters, how many invisible characters. */
  detail: Record<string, string | number>;
}

/** One finding of a job, placed: what the database stores (`job_traps`). */
export interface TrapFinding {
  technique: TrapTechnique;
  method: string | null;
  severity: TrapSeverity;
  /** C7: verbatim text; the JD's own text when `quoteSource` is `description`. */
  quote: string;
  quoteSource: "description" | "raw";
  /** Where `quote` starts in `jobs.description`; null for a quote only the source page has. */
  quoteOffset: number | null;
  /** `description`, or the field path in the source payload (`raw:posting.content`, `raw:descriptionHtml@alt`). */
  location: string;
  /** The source posting the finding comes from; null for a finding of the JD text itself. */
  rawPostingId: number | null;
  evidence: string | null;
  detail: Record<string, string | number>;
  inDescription: boolean;
}

/** A piece of the JD that must not reach an AI: hidden text (any severity) or a visible instruction. */
export interface TrapSpan {
  offset: number;
  length: number;
  /** hidden: replaced with the hidden marker; instruction: with the instruction marker; invisible: its invisible characters deleted. */
  kind: "hidden" | "instruction" | "invisible";
}

/** The two marker texts of traps.yaml `ai_input`. */
export interface TrapMarkers {
  hidden: string;
  instruction: string;
}
