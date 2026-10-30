/** Lower case, accents folded, ß -> ss: "München" and "munchen" compare equal. */
export function foldText(value: string): string {
  return value
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}

/** Apply the market's alternative spellings before folding accents and case. */
export function foldTransliterated(value: string, transliterations: Readonly<Record<string, string>>): string {
  let out = value;
  for (const [letter, spelling] of Object.entries(transliterations)) out = out.replace(new RegExp(letter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), spelling);
  return foldText(out);
}
