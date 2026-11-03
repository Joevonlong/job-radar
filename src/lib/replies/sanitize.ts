/**
 * Mail text is untrusted (C6). `htmlToVisibleText` keeps only what a reader would see: hidden nodes are dropped, not just reported,
 * because the quote on /pipeline is cut from this text. This works whether or not the trap feature is on: its visibility helpers
 * and instruction patterns are used, its switch is not read.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

import type { TrapsConfig } from "@/lib/config/schemas/traps";
import { parseStyle } from "@/lib/traps/css";
import { childContext, hiddenBy, type Context } from "@/lib/traps/html";
import { compilePatterns, findPatternHits } from "@/lib/traps/instructions";
import { NON_RENDERED_TAGS } from "@/lib/traps/types";
import { stripInvisible } from "@/lib/traps/unicode";

/** What counts as hidden in a mail; fixed here so a user's traps.yaml (or an unreadable one) cannot weaken what the quote shows. */
const EMAIL_HIDDEN: TrapsConfig["hidden"] = {
  methods: { color_match: true, display_none: true, visibility_hidden: true, opacity: true, font_size: true, offscreen: true, clip: true, zero_size: true, hidden_attribute: true, aria_hidden: true, hidden_class: true },
  color: { min_contrast: 1.5, assumed_background: ["#ffffff"] },
  opacity_max: 0.1,
  font_size_max_px: 1,
  offscreen_min_px: 500,
  size_max_px: 1,
  classes: ["sr-only", "visually-hidden", "visuallyhidden", "screen-reader-text", "screen-reader-only", "hidden", "d-none", "hide", "invisible", "offscreen"],
  benign: [],
};

/** Instruction patterns used when traps.yaml cannot be read. */
const FALLBACK_INSTRUCTIONS: TrapsConfig["instructions"] = [
  { id: "mail_ignore_previous", lang: "en", pattern: "\\bignore (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|prompts?)\\b", flags: "iu" },
  { id: "mail_if_you_are_an_ai", lang: "en", pattern: "\\bif you(?:'re| are) an? (?:ai|llm|language model|assistant)\\b", flags: "iu" },
  { id: "mail_ignore_de", lang: "de", pattern: "\\bignorier\\w* (?:alle )?(?:vorherigen|obigen) (?:Anweisungen|Befehle)\\b", flags: "iu" },
];

const BLOCK_TAGS = new Set(["address", "article", "aside", "blockquote", "br", "center", "dd", "div", "dl", "dt", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
/** Unicode tag characters: invisible ASCII that `stripInvisible` leaves for the trap scan to decode. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
/** Control characters (Postgres text refuses NUL), the direction marks and soft hyphen `stripInvisible` leaves. Line ends and tabs stay for the callers to fold. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200E\u200F]/gu;

const withoutInvisible = (text: string): string => stripInvisible(text).replace(TAG_CHARS, "").replace(CONTROL_CHARS, "");

/** A header value (subject, display name, address, ids) as one clean line. */
export function cleanHeader(text: string): string {
  return withoutInvisible(text).replace(/[\s\u00A0]+/gu, " ").trim();
}

function cleanLines(text: string): string {
  return withoutInvisible(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/[\s ]+/gu, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** The text a reader of this HTML would see, one line per block. */
export function htmlToVisibleText(html: string): string {
  const $ = cheerio.load(html);
  const parts: string[] = [];
  const walk = (node: AnyNode, context: Context): void => {
    if (node.type === "text") {
      parts.push(node.data);
      return;
    }
    if (node.type === "root") {
      for (const child of node.children) walk(child, context);
      return;
    }
    if (node.type !== "tag") return; // comments, scripts and styles are never rendered
    const el = node as Element;
    const tag = el.name.toLowerCase();
    if ((NON_RENDERED_TAGS as readonly string[]).includes(tag) || tag === "head" || tag === "title") return;
    const declarations = parseStyle(el.attribs.style);
    if (hiddenBy(el, declarations, context, EMAIL_HIDDEN)) return;
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push("\n");
    const next = childContext(el, declarations, context);
    for (const child of el.children) walk(child, next);
    if (block) parts.push("\n");
  };
  walk($.root()[0] as AnyNode, { color: null, background: null });
  return cleanLines(parts.join(""));
}

/** A plain-text body, cleaned the same way. */
export function plainToVisibleText(text: string): string {
  return cleanLines(text);
}

/** Drops quoted history: a reply repeats the older mail below `> ` lines or an "On ... wrote:" line. */
export function withoutQuotedHistory(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^>/.test(line)) continue;
    if (/^(?:On .{5,120} wrote:|Am .{5,120} schrieb .{1,120}:)$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** The visible text of a message: its HTML part when it has one, its plain part otherwise. */
export function visibleBody(message: { html: string | null; text: string | null }): string {
  const text = message.html !== null ? htmlToVisibleText(message.html) : plainToVisibleText(message.text ?? "");
  return withoutQuotedHistory(text);
}

/** Whether a text addresses an AI (only marked on the row: no AI ever reads a mail). */
export function hasSuspiciousInstruction(text: string, traps: TrapsConfig | null): boolean {
  const list = traps?.instructions ?? FALLBACK_INSTRUCTIONS;
  return findPatternHits(text, compilePatterns(list, [...new Set(list.map((pattern) => pattern.lang))])).length > 0;
}

/** Whether a message hides instructions, or shows them: looks at everything the HTML holds, not only the visible text. */
export function messageHasInstruction(message: { html: string | null; text: string | null }, visible: string, traps: TrapsConfig | null): boolean {
  if (hasSuspiciousInstruction(visible, traps)) return true;
  if (message.html === null) return false;
  const $ = cheerio.load(message.html);
  const textNodes = [...$.root().contents().toArray(), ...$.root().find("*").contents().toArray()].flatMap((node) => (node.type === "text" ? [node.data] : []));
  return hasSuspiciousInstruction(cleanLines(textNodes.join("\n")), traps);
}
