import { FONT_FACES } from "../engine/fonts.generated";

const ranges = FONT_FACES.flatMap((face) => face.unicodeRange.split(",").map((part) => {
  const [first, last] = part.trim().replace(/^U\+/i, "").split("-");
  return [parseInt(first!, 16), parseInt(last ?? first!, 16)] as const;
}));

export function uncoveredCharacters(text: string, maxChars: number): string[] {
  const uncovered = new Set<string>();
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    const point = character.codePointAt(0)!;
    if (!ranges.some(([first, last]) => point >= first && point <= last)) uncovered.add(character);
    if (uncovered.size >= maxChars) break;
  }
  return [...uncovered];
}
