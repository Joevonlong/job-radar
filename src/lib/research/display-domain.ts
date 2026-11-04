/** How a domain is shown to people. Pure, so client components may import it. */

const PUNY = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128 } as const;

function adapt(delta: number, points: number, first: boolean): number {
  let d = first ? Math.floor(delta / PUNY.damp) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((PUNY.base - PUNY.tMin) * PUNY.tMax) >> 1) {
    d = Math.floor(d / (PUNY.base - PUNY.tMin));
    k += PUNY.base;
  }
  return k + Math.floor(((PUNY.base - PUNY.tMin + 1) * d) / (d + PUNY.skew));
}

/** One punycode label without its `xn--` prefix (RFC 3492), or null when it is malformed. */
function decodePunycode(input: string): string | null {
  const split = input.lastIndexOf("-");
  const output: number[] = [...input.slice(0, Math.max(split, 0))].map((char) => char.codePointAt(0) ?? 0);
  if (output.some((code) => code > 0x7f)) return null;
  let n: number = PUNY.initialN;
  let bias: number = PUNY.initialBias;
  let i = 0;
  let index = split > 0 ? split + 1 : 0;
  while (index < input.length) {
    const old = i;
    let weight = 1;
    for (let k = PUNY.base; ; k += PUNY.base) {
      if (index >= input.length) return null;
      const code = input.charCodeAt(index);
      index += 1;
      const digit = code >= 0x30 && code <= 0x39 ? code - 0x16 : code >= 0x41 && code <= 0x5a ? code - 0x41 : code >= 0x61 && code <= 0x7a ? code - 0x61 : PUNY.base;
      if (digit >= PUNY.base) return null;
      i += digit * weight;
      const t = k <= bias ? PUNY.tMin : k >= bias + PUNY.tMax ? PUNY.tMax : k - bias;
      if (digit < t) break;
      weight *= PUNY.base - t;
    }
    bias = adapt(i - old, output.length + 1, old === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return output.length === 0 ? null : String.fromCodePoint(...output);
}

/** The scripts a shown label may be written in; a label uses one of them (Japanese may combine Han with kana). Digits and hyphens belong to every script. */
const SCRIPT_GROUPS: readonly (readonly string[])[] = [["Latin"], ["Cyrillic"], ["Greek"], ["Han", "Hiragana", "Katakana"], ["Han", "Bopomofo"], ["Han", "Hangul"], ["Arabic"], ["Hebrew"], ["Thai"], ["Devanagari"]];

/** Looks like what it is: one script, no control, format, unassigned or separator characters, and the same label again when encoded. */
function safeToShow(label: string, decoded: string): boolean {
  if (/[\p{C}\p{Z}]/u.test(decoded)) return false;
  const letters = [...decoded].filter((char) => /\p{L}|\p{M}/u.test(char));
  const fits = SCRIPT_GROUPS.some((group) => letters.every((char) => group.some((script) => new RegExp(`\\p{Script_Extensions=${script}}`, "u").test(char))));
  if (!fits) return false;
  try {
    return new URL(`https://${decoded}.test`).hostname === `${label.toLowerCase()}.test`;
  } catch {
    return false;
  }
}

/**
 * A domain as people read it: international labels (`xn--mnchen-bau-9db.de`) in their letters. A label that mixes scripts (a Cyrillic
 * letter among Latin ones), holds invisible or control characters, or does not encode back to itself stays in its `xn--` form, so a
 * look-alike is not made to look right. Only for display: lookups and requests use the stored form.
 */
export function displayDomain(domain: string): string {
  return domain
    .split(".")
    .map((label) => {
      if (!label.toLowerCase().startsWith("xn--")) return label;
      const decoded = decodePunycode(label.slice(4));
      return decoded !== null && safeToShow(label, decoded) ? decoded : label;
    })
    .join(".");
}
