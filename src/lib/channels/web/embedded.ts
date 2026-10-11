import { ChannelError } from "../errors";

/**
 * Data a web page embeds for its own front end: JSON assigned to a `window.*` variable and
 * JSON-LD `<script>` blocks. Both job boards deliver everything we need this way, so no browser and
 * no DOM parser is involved.
 */

const IDENTIFIER_CHAR = /[\w$]/;

/** Index of the first `{` at or after `from`, or -1. */
function nextBrace(text: string, from: number): number {
  return text.indexOf("{", from);
}

/**
 * The JSON object that starts at the first `{` after `anchor`. JavaScript's bare `undefined` (which
 * server-side serializers leave in) is read as `null`. Returns null when the anchor is absent;
 * throws `ChannelError("parse")` when the object is cut off or is not JSON.
 */
export function extractJsonAfter(html: string, anchor: string | RegExp, what: string): unknown {
  let from: number;
  if (typeof anchor === "string") {
    const at = html.indexOf(anchor);
    if (at < 0) return null;
    from = at + anchor.length;
  } else {
    const match = anchor.exec(html);
    if (!match) return null;
    from = match.index + match[0].length;
  }
  const start = nextBrace(html, from);
  if (start < 0) throw new ChannelError("parse", `${what}: no object after the anchor`);

  let out = "";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html.charAt(i);
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "u" && html.startsWith("undefined", i) && !IDENTIFIER_CHAR.test(html.charAt(i - 1)) && !IDENTIFIER_CHAR.test(html.charAt(i + 9))) {
      out += "null";
      i += "undefined".length - 1;
      continue;
    }
    out += char;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(out) as unknown;
        } catch (error) {
          throw new ChannelError("parse", `${what}: embedded data is not valid JSON`, { cause: error });
        }
      }
    }
  }
  throw new ChannelError("parse", `${what}: embedded data is cut off`);
}

const LD_JSON = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Every JSON-LD block of the page that is valid JSON, in document order (invalid blocks are skipped). */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(LD_JSON)) {
    const body = match[1];
    if (body === undefined) continue;
    try {
      blocks.push(JSON.parse(body.trim()) as unknown);
    } catch {
      // a broken block of some other schema type must not hide the posting
    }
  }
  return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJobPosting(value: Record<string, unknown>): boolean {
  const type = value["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

/** The schema.org `JobPosting` among JSON-LD blocks (top level, in an array or in an `@graph`), or null. */
export function findJobPosting(blocks: readonly unknown[]): Record<string, unknown> | null {
  for (const block of blocks) {
    const candidates = Array.isArray(block) ? block : [block];
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;
      if (isJobPosting(candidate)) return candidate;
      const graph = candidate["@graph"];
      if (Array.isArray(graph)) {
        const found = graph.find((node): node is Record<string, unknown> => isRecord(node) && isJobPosting(node));
        if (found) return found;
      }
    }
  }
  return null;
}
