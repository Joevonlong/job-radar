import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { FontFace } from "../src/lib/career/engine/fonts";

const ROOT = path.resolve(import.meta.dirname, "..");
export const FONT_TABLE = "src/lib/career/engine/fonts.generated.ts";
export const FONT_WEIGHTS = {
  inter: [400, 500, 600, 700],
  newsreader: [500, 600],
  "ibm-plex-sans": [400, 500, 600],
  "ibm-plex-mono": [400, 500],
} as const;

export interface FontReaders {
  text(file: string): string;
  bytes(file: string): Uint8Array;
}

export function readFontFaces(read: FontReaders): FontFace[] {
  return Object.entries(FONT_WEIGHTS).flatMap(([pkg, weights]) => weights.flatMap((weight) => {
    const directory = `node_modules/@fontsource/${pkg}`;
    const metadata = `${directory}/${weight}.css`;
    const css = read.text(metadata);
    return ["latin", "latin-ext"].map((subset) => {
      const file = `${pkg}-${subset}-${weight}-normal.woff2`;
      const blocks = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);
      const block = blocks.find((body) => body.includes(`./files/${file}`));
      const family = block?.match(/font-family:\s*['"]([^'"]+)['"]/i)?.[1];
      const unicodeRange = block?.match(/unicode-range:\s*([^;]+);/i)?.[1]?.trim();
      if (!family || !unicodeRange || !block?.includes(`font-weight: ${weight};`) || !block.includes("font-style: normal;")) {
        throw new Error(`${metadata}: missing or invalid metadata for ${file}`);
      }
      const bytes = read.bytes(`${directory}/files/${file}`);
      if (!bytes.length) throw new Error(`${file}: empty font file`);
      return { family, weight, subset, unicodeRange, woff2Base64: Buffer.from(bytes).toString("base64") };
    });
  }));
}

export function renderFontTable(faces: readonly FontFace[]): string {
  return ['import type { FontFace } from "./fonts";', "", "export const FONT_FACES: readonly FontFace[] = [",
    ...faces.map((face) => `  ${JSON.stringify(face)},`), "];", ""].join("\n");
}

export function checkFontTable(committed: string | undefined, expected: string): string[] {
  if (committed === undefined) return [`${FONT_TABLE} is missing: run pnpm career:fonts`];
  return committed === expected ? [] : [`${FONT_TABLE} is out of date: run pnpm career:fonts`];
}

export function main(): number {
  try {
    const { values } = parseArgs({ options: { check: { type: "boolean" } }, strict: true });
    const faces = readFontFaces({ text: (file) => fs.readFileSync(path.join(ROOT, file), "utf8"), bytes: (file) => fs.readFileSync(path.join(ROOT, file)) });
    const expected = renderFontTable(faces);
    const output = path.join(ROOT, FONT_TABLE);
    if (values.check) {
      const problems = checkFontTable(fs.existsSync(output) ? fs.readFileSync(output, "utf8") : undefined, expected);
      for (const problem of problems) console.error(problem);
      if (problems.length) return 1;
    } else fs.writeFileSync(output, expected);
    console.log(`career fonts ${values.check ? "current" : "generated"}: ${faces.length} faces`);
    return 0;
  } catch (error) {
    console.error(`career:fonts: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
