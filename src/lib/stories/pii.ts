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
