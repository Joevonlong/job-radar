/**
 * Combining marks that are diacritics on Latin, Greek and Cyrillic letters: the combining diacritical marks (accents,
 * cedilla, breve ...) with their extended and supplement blocks, the Cyrillic titlo / palatalization marks, the marks for
 * symbols and the half marks; also the variation selectors (emoji / glyph presentation, no letter of their own). Marks
 * of other scripts are part of the letter and stay: Devanagari and Thai vowel signs, the Japanese voicing marks (ジ is not シ).
 */
const DIACRITICS = /[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︀-️︠-︯\u{e0100}-\u{e01ef}]/gu;

/** NFKD with the diacritics above removed ("Société" -> "Societe", "ジ" -> "シ" + voicing mark). Compose with `NFC` when done. */
export function foldDiacritics(text: string): string {
  return text.normalize("NFKD").replace(DIACRITICS, "");
}
