import type { PipelineConfig } from "@/lib/config";

import { compileRules } from "./rules";

/**
 * Clean-up of a description after HTML is gone (settings in pipeline.yaml `description`):
 * 1. interface text a scraper left at the very end ("Show more Show less") is cut off;
 * 2. a long description that has no line break at all (Bright Data's LinkedIn summary) gets its
 *    structure back: bullet glyphs, known section headings and sentences become lines / paragraphs.
 * Only whitespace is added, a glyph is swapped for "- ", and the trailing interface text is removed:
 * no word of the posting is changed (C3, C7: quotes stay verbatim substrings of the stored text).
 */
export function cleanDescription(text: string, config: PipelineConfig): string {
  const trimmed = stripTrailingUi(text, config);
  return restoreStructure(trimmed, config);
}

/** The text without scraper interface leftovers at its end. */
export function stripTrailingUi(text: string, config: PipelineConfig): string {
  const patterns = compileRules(config).trailingUi;
  let out = text.trim();
  for (let changed = true; changed; ) {
    changed = false;
    for (const pattern of patterns) {
      const next = out.replace(pattern, "").trimEnd();
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
  }
  return out;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A heading phrase as a regex source: spaces flexible, straight and curly apostrophes alike. */
function headingSource(heading: string): string {
  return heading
    .trim()
    .split(/\s+/)
    .map((word) => escapeRegExp(word).replace(/['’]/g, "['’]"))
    .join("\\s+");
}

interface Structure {
  headings: RegExp | null;
  glyphs: RegExp | null;
  abbreviations: Set<string>;
}

const structureCache = new WeakMap<PipelineConfig, Structure>();

function structureOf(config: PipelineConfig): Structure {
  const hit = structureCache.get(config);
  if (hit) return hit;
  const { section_headings, bullet_glyphs, abbreviations } = config.description.restore;
  const sources = [...section_headings].sort((a, b) => b.length - a.length).map(headingSource);
  const built: Structure = {
    // a heading phrase, followed by ":" / "." (taken along) or by a capitalised word (the text that belongs under it)
    headings: sources.length === 0 ? null : new RegExp(`(?<![\\p{L}\\p{N}])(${sources.join("|")})(?:(\\s*[:.])|(?=\\s+[\\p{Lu}\\p{N}•\\-]))`, "giu"),
    glyphs: bullet_glyphs.length === 0 ? null : new RegExp(`(?:^|\\s)[${bullet_glyphs.map(escapeRegExp).join("")}]\\s*`, "gu"),
    abbreviations: new Set(abbreviations.map((a) => a.toLowerCase())),
  };
  structureCache.set(config, built);
  return built;
}

const SENTENCE_GAP = /(?<=[.!?])\s+(?=[\p{Lu}\p{N}„"“(])/gu;

/** Whether the dot that ends `before` is part of an abbreviation or an initial ("e.g.", "z.B.", "J."). */
function endsWithAbbreviation(before: string, abbreviations: ReadonlySet<string>): boolean {
  const word = /([\p{L}.]+)\.$/u.exec(before)?.[1];
  if (word === undefined) return false;
  return abbreviations.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word);
}

function splitSentences(line: string, abbreviations: ReadonlySet<string>): string[] {
  const sentences: string[] = [];
  let from = 0;
  for (const m of line.matchAll(SENTENCE_GAP)) {
    const before = line.slice(from, m.index);
    if (endsWithAbbreviation(before, abbreviations)) continue;
    sentences.push(before);
    from = m.index + m[0].length;
  }
  sentences.push(line.slice(from));
  return sentences;
}

/** Sentences of one long line grouped into paragraphs of about `paragraphChars` characters. */
function paragraphsOf(line: string, paragraphChars: number, abbreviations: ReadonlySet<string>): string[] {
  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of splitSentences(line, abbreviations)) {
    current = current === "" ? sentence : `${current} ${sentence}`;
    if (current.length >= paragraphChars) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current !== "") paragraphs.push(current);
  return paragraphs;
}

/** Headings, bullets and sentences of a one-paragraph description as lines again. Text that already has line breaks, or is short, is returned unchanged. */
export function restoreStructure(text: string, config: PipelineConfig): string {
  const { min_chars, paragraph_chars } = config.description.restore;
  if (text.includes("\n") || text.length < min_chars) return text;
  const structure = structureOf(config);

  let out = text;
  if (structure.glyphs) out = out.replace(structure.glyphs, "\n- ");
  if (structure.headings) {
    const source = out;
    out = source.replace(structure.headings, (match: string, heading: string, punctuation: string | undefined, offset: number) => {
      // only a capitalised phrase at the start of a sentence (or before ":") is a heading
      if (!/^\p{Lu}/u.test(heading)) return match;
      const before = source.slice(0, offset).trimEnd();
      const atStart = before === "" || /[.!?:)\]\n]$/u.test(before);
      const withColon = punctuation !== undefined && punctuation.includes(":");
      return atStart || withColon ? `\n\n${heading}${punctuation?.trim() ?? ""}\n` : match;
    });
  }

  const lines = out.split("\n").map((l) => l.trim());
  const rebuilt: string[] = [];
  for (const line of lines) {
    if (line === "") {
      rebuilt.push("");
    } else if (line.startsWith("- ") || line.length <= paragraph_chars) {
      rebuilt.push(line);
    } else {
      rebuilt.push(...paragraphsOf(line, paragraph_chars, structure.abbreviations).flatMap((p, i, all) => (i < all.length - 1 ? [p, ""] : [p])));
    }
  }
  return rebuilt
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
