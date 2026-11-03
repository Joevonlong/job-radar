import { isDeepStrictEqual } from "node:util";

import { LineCounter, parseDocument } from "yaml";
import type { z } from "zod";

/**
 * A shipped YAML file can list a section's defaults as a commented-out block between two marker lines. These read such a
 * block and hold it equal to the schema's defaults. Nothing is guessed: any other shape is a failure with its line number.
 */
export interface CommentedBlockShape {
  start: string;
  end: string;
  /** What every line between the markers starts with; a line that is exactly this without its trailing space is empty. */
  prefix: string;
}

export type CommentedDefaults = { ok: true; value: unknown } | { ok: false; reason: string; line: number };

const fail = (reason: string, line: number): CommentedDefaults => ({ ok: false, reason, line });

/** The value of the commented block of `text`. Line numbers count from 1. */
export function readCommentedDefaults(text: string, shape: CommentedBlockShape): CommentedDefaults {
  const lines = text.split("\n").map((line) => line.replace(/\s+$/, ""));
  const at = (marker: string): number[] => lines.flatMap((line, index) => (line === marker ? [index] : []));
  const starts = at(shape.start.trimEnd());
  const ends = at(shape.end.trimEnd());
  if (starts.length === 0) return fail("missing start marker", 1);
  if (ends.length === 0) return fail("missing end marker", (starts[0] as number) + 1);
  if (starts.length > 1) return fail("duplicate start marker", (starts[1] as number) + 1);
  if (ends.length > 1) return fail("duplicate end marker", (ends[1] as number) + 1);
  const [start, end] = [starts[0] as number, ends[0] as number];
  if (end < start) return fail("end marker before start marker", end + 1);

  const empty = shape.prefix.trimEnd();
  const raw = text.split("\n");
  const body: string[] = [];
  for (let i = start + 1; i < end; i += 1) {
    const line = raw[i] as string;
    if (line.trimEnd() === empty) body.push("");
    else if (line.startsWith(shape.prefix)) body.push(line.slice(shape.prefix.length));
    else return fail(`line ${i + 1} between the markers does not start with '${shape.prefix}'`, i + 1);
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(body.join("\n"), { lineCounter });
  const problem = document.errors[0];
  if (problem) {
    const line = start + 1 + lineCounter.linePos(problem.pos[0]).line;
    return fail(`the block is not valid YAML: ${problem.message.split("\n")[0]}`, line);
  }
  return { ok: true, value: document.toJS() };
}

/** Compare a commented block with a schema's defaults: exactly the one key, exactly the schema's fields, equal values. */
export function checkCommentedDefaults(text: string, shape: CommentedBlockShape, section: string, schema: z.ZodObject): CommentedDefaults {
  const read = readCommentedDefaults(text, shape);
  if (!read.ok) return read;
  const line = text.split("\n").findIndex((candidate) => candidate.trimEnd() === shape.start.trimEnd()) + 1;
  const value = read.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`the block must be a mapping with the one key ${section}`, line);
  const topKeys = Object.keys(value);
  if (topKeys.length !== 1 || topKeys[0] !== section) return fail(`the block must have the one key ${section}, it has: ${topKeys.join(", ") || "none"}`, line);
  const listed = (value as Record<string, unknown>)[section];
  if (listed === null || typeof listed !== "object" || Array.isArray(listed)) return fail(`${section} must be a mapping`, line);
  const entries = listed as Record<string, unknown>;
  const defaults = schema.parse({}) as Record<string, unknown>;
  const fields = Object.keys(schema.shape);
  const extra = Object.keys(entries).filter((key) => !fields.includes(key));
  if (extra.length > 0) return fail(`unknown key ${extra.join(", ")}`, line);
  const missing = fields.filter((key) => !Object.hasOwn(entries, key));
  if (missing.length > 0) return fail(`missing key ${missing.join(", ")}`, line);
  for (const key of fields) {
    if (!isDeepStrictEqual(entries[key], defaults[key])) return fail(`${key} is ${JSON.stringify(entries[key])} in the block, the default is ${JSON.stringify(defaults[key])}`, line);
  }
  return read;
}

export const TITLE_GUARD_BLOCK: CommentedBlockShape = { start: "  # >>> title_guard defaults", end: "  # <<< title_guard defaults", prefix: "  # " };
