/**
 * Line diff of two config / profile texts (moved here from the profile page: the advanced editor and the profile
 * history render the same thing). Pure and free of server-only imports.
 */
import { structuredPatch } from "diff";
import { parse } from "yaml";

export interface DiffLine {
  type: "context" | "add" | "del" | "gap";
  text: string;
}

/** Unchanged lines shown around each change in a diff preview. */
const DEFAULT_CONTEXT_LINES = 1;

/** Line diff of two YAML texts, reduced to the changed lines plus a little context. */
export function diffYaml(oldText: string, newText: string, context = DEFAULT_CONTEXT_LINES): DiffLine[] {
  const patch = structuredPatch("old", "new", oldText, newText, "", "", { context });
  const out: DiffLine[] = [];
  patch.hunks.forEach((hunk, index) => {
    if (index > 0) out.push({ type: "gap", text: "" });
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const marker = line[0];
      out.push({ type: marker === "+" ? "add" : marker === "-" ? "del" : "context", text: line.slice(1) });
    }
  });
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leafPaths(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (isRecord(a) && isRecord(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) leafPaths(a[key], b[key], prefix === "" ? key : `${prefix}.${key}`, out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix === "" ? "(root)" : prefix);
}

/**
 * Dotted key paths whose values differ between two YAML texts (the summary above a diff). A list counts as one value.
 * Null when either text is not valid YAML (the line diff still works).
 */
export function changedKeyPaths(oldText: string, newText: string): string[] | null {
  try {
    const out: string[] = [];
    leafPaths(parse(oldText) as unknown, parse(newText) as unknown, "", out);
    return out;
  } catch {
    return null;
  }
}
