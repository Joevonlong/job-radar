import { FONT_FACES } from "./fonts.generated";
import type { FontRef } from "./theme";

export interface FontFace {
  family: string;
  weight: number;
  subset: string;
  unicodeRange: string;
  woff2Base64: string;
}

export function fontFaceCssFromTable(fonts: FontRef[], table: readonly FontFace[]): string {
  return fonts.flatMap((font) => table
    .filter((row) => row.family === font.family && row.weight === font.weight)
    .map((row) => `@font-face { font-family: '${row.family}'; font-style: normal; font-display: block; font-weight: ${row.weight}; src: url(data:font/woff2;base64,${row.woff2Base64}) format('woff2'); unicode-range: ${row.unicodeRange}; }`))
    .join("\n");
}

export function fontFaceCss(fonts: FontRef[]): string {
  return fontFaceCssFromTable(fonts, FONT_FACES);
}
