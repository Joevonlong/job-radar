import { findPiiSpans } from "@/lib/stories/pii";

export type ScrubKind = "email" | "phone" | "link" | "name" | "address" | "work_auth" | "availability";
export interface StoredValues {
  values: readonly { value: string; kind: ScrubKind; highlightOnly?: boolean }[];
  location?: string | null;
}
export interface ScrubRules {
  max_chars: number;
  title_words: readonly string[];
  sensitive_labels: readonly string[];
}
export interface Highlight { start: number; end: number; kind: string }
const links = /(?:https?:\/\/|www\.|(?:linkedin\.com\/in\/|github\.com\/|xing\.com\/))[^\s<>\[\]]+/giu;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function valuePattern(value: string): RegExp | null {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.length ? new RegExp(`(?<![\\p{L}\\p{N}_])${words.map(escape).join("\\s+")}(?![\\p{L}\\p{N}_])`, "giu") : null;
}

function storedSpans(text: string, stored: StoredValues): (Highlight & { replace: boolean })[] {
  const placeholders = [...text.matchAll(/\[(?:email|phone|link|name|address|work_auth|availability)\]/g)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  return stored.values.flatMap(({ value, kind, highlightOnly }) => {
    const pattern = valuePattern(value);
    return pattern ? [...text.matchAll(pattern)].filter((match) => !placeholders.some((span) => match.index < span.end && match.index + match[0].length > span.start)).map((match) => ({ start: match.index, end: match.index + match[0].length, kind, replace: !highlightOnly })) : [];
  });
}

function replaceSpans(text: string, spans: readonly Highlight[]): { text: string; removed: number } {
  let end = 0;
  let result = "";
  let removed = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (span.start < end) continue;
    result += text.slice(end, span.start) + `[${span.kind}]`;
    end = span.end;
    removed++;
  }
  return { text: result + text.slice(end), removed };
}

function scrub(text: string, stored: StoredValues, full: boolean) {
  const spans: Highlight[] = storedSpans(text, stored).filter((span) => span.replace);
  spans.push(...findPiiSpans(text).filter((span) => span.kind === "email" || (full && span.kind === "phone")));
  if (full) spans.push(...[...text.matchAll(links)].map((match) => ({ start: match.index, end: match.index + match[0].length, kind: "link" })));
  return replaceSpans(text, spans);
}

/** Confirmation preserves phone/date corrections made in the preview. */
export function scrubFinal(text: string, stored: StoredValues) { return scrub(text, stored, false); }
export function scrubOutbound(text: string, stored: StoredValues) { return scrub(text, stored, true); }

/** Candidate values exist only in the response to a preview request. */
export function prepareScrub(text: string, input: { stored: StoredValues; rules: ScrubRules; name?: string; address?: string; mode?: "values" }) {
  const first = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !input.rules.title_words.some((title) => title.toLocaleLowerCase() === line.toLocaleLowerCase()));
  const guessed = first && /^(?:\p{L}[\p{L}'’-]*\s+){1,3}\p{L}[\p{L}'’-]*$/u.test(first) ? first : null;
  const name = input.name ?? (input.mode === "values" ? null : guessed);
  const address = input.address ?? null;
  const stored: StoredValues = { ...input.stored, values: [...input.stored.values, ...(name ? [{ value: name, kind: "name" as const }] : []), ...(address ? [{ value: address, kind: "address" as const }] : [])] };
  const whole = scrub(text, stored, input.mode !== "values");
  const truncated = whole.text.length > input.rules.max_chars;
  const final = whole.text.slice(0, input.rules.max_chars);
  const highlights: Highlight[] = [...findPiiSpans(final).filter((span) => span.kind === "maybe_phone"), ...storedSpans(final, stored).filter((span) => !span.replace)];
  for (const label of [...input.rules.sensitive_labels, ...(stored.location ? [stored.location] : [])]) {
    const pattern = valuePattern(label);
    if (pattern) for (const match of final.matchAll(pattern)) {
      const end = input.rules.sensitive_labels.includes(label) ? final.indexOf("\n", match.index) : match.index + match[0].length;
      highlights.push({ start: match.index, end: end < 0 ? final.length : end, kind: stored.location === label ? "location" : "sensitive" });
    }
  }
  return { text: final, candidates: { name, address }, removed: whole.removed, chars: final.length, truncated, highlights };
}
