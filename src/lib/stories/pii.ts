/**
 * Contact details in story text. Stories are written to be sent to an AI provider, so /me warns before a save when one
 * looks like it holds an email address or a phone number; the save is never blocked (the patterns can be wrong both ways).
 */

export type PiiKind = "email" | "phone";

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u;
/** A run of digits with phone-like separators (space, no-break space, hyphen, slash, parentheses); judged by `looksLikePhone`. */
const DIGIT_RUN = /(?<![\p{L}\p{N}.,])\+?\(?\d[\d  ()/-]{5,}\d(?![\p{L}\p{N}%]|[.,]\d)/gu;

/**
 * 8 to 15 digits, and written like a phone number: an international `+` or an area code in parentheses, three or more
 * digit groups, or a leading 0 with nine or more digits. Years ("2019-2023"), ranges and amounts stay out.
 */
function looksLikePhone(run: string): boolean {
  const digits = run.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return false;
  if (run.startsWith("+") || run.startsWith("(")) return true;
  const groups = run.split(/[  ()/-]+/).filter((group) => group !== "");
  if (groups.length >= 3) return true;
  return run.startsWith("0") && digits.length >= 9;
}

/** The kinds of contact details found in `text`, each at most once, in a fixed order. */
export function findPii(text: string): PiiKind[] {
  const found: PiiKind[] = [];
  if (EMAIL.test(text)) found.push("email");
  for (const match of text.matchAll(DIGIT_RUN)) {
    if (looksLikePhone(match[0].trim())) {
      found.push("phone");
      break;
    }
  }
  return found;
}

/** The kinds found in any of `texts`. */
export function findPiiIn(texts: readonly string[]): PiiKind[] {
  const kinds = new Set(texts.flatMap((text) => findPii(text)));
  return (["email", "phone"] as const).filter((kind) => kinds.has(kind));
}

export interface PiiSpan {
  kind: PiiKind | "maybe_phone";
  start: number;
  end: number;
}

/** Résumé dates and grouped amounts are protected only for outbound scrubbing; story warnings retain their behavior. */
export function findPiiSpans(text: string): PiiSpan[] {
  const spans: PiiSpan[] = [...text.matchAll(new RegExp(EMAIL.source, "gu"))].map((match) => ({
    kind: "email", start: match.index, end: match.index + match[0].length,
  }));
  const dates = /(?<!\d)(?:\(?[1-9]\d{3}\/\d{2}\s*[-–—]\s*[1-9]\d{3}\/\d{2}\)?|\(?[1-9]\d{3}\s*[-–—]\s*[1-9]\d{3}\)?|[1-9]\d{3}-(?:0[1-9]|1[0-2])|(?:0?[1-9]|1[0-2])\/[1-9]\d{3}|(?:0?[1-9]|[12]\d|3[01])\/(?:0?[1-9]|1[0-2])\/[1-9]\d{3})(?!\d)/gu;
  const characters = text.split("");
  for (const match of text.matchAll(dates)) characters.fill("x", match.index, match.index + match[0].length);
  const masked = characters.join("");
  for (const match of masked.matchAll(DIGIT_RUN)) {
    let run = match[0].trimEnd();
    if (run.startsWith("(") && text[match.index + run.length] === ")" && (run.match(/\(/g)?.length ?? 0) > (run.match(/\)/g)?.length ?? 0)) run += ")";
    const digits = run.replace(/\D/g, "");
    if (digits.length < 8) continue;
    if (/^[1-9]\d{0,2}(?:[  ]\d{3})+$/.test(run)) continue;
    spans.push({ kind: looksLikePhone(run) ? "phone" : "maybe_phone", start: match.index, end: match.index + run.length });
  }
  return spans.sort((a, b) => a.start - b.start);
}
