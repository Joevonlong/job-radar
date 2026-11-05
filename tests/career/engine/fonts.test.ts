// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { FONT_FACES } from "../../../src/lib/career/engine/fonts.generated";
import { THEMES } from "../../../src/lib/career/engine/themes";
import { checkFontTable, FONT_TABLE, readFontFaces, renderFontTable } from "../../../scripts/career-engine-fonts";

const root = path.resolve(import.meta.dirname, "../../..");
const readers = { text: (file: string) => fs.readFileSync(path.join(root, file), "utf8"), bytes: (file: string) => fs.readFileSync(path.join(root, file)) };

test("every declared theme weight embeds both Latin subsets", () => {
  expect(FONT_FACES).toHaveLength(22);
  for (const { template } of Object.values(THEMES)) for (const font of template.fonts) {
    expect(FONT_FACES.filter((row) => row.family === font.family && row.weight === font.weight).map((row) => row.subset).sort(), JSON.stringify(font))
      .toEqual(["latin", "latin-ext"]);
  }
});

test("the committed table matches installed files and changed or removed rows are stale", () => {
  const expected = renderFontTable(readFontFaces(readers));
  const committed = fs.readFileSync(path.join(root, FONT_TABLE), "utf8");
  expect(checkFontTable(committed, expected)).toEqual([]);
  expect(renderFontTable(FONT_FACES)).toBe(expected);
  expect(checkFontTable(renderFontTable(FONT_FACES.slice(1)), expected)).toEqual([expect.stringContaining("out of date")]);
  expect(checkFontTable(renderFontTable(FONT_FACES.map((row, i) => i === 0 ? { ...row, weight: 900 } : row)), expected)).toEqual([expect.stringContaining("out of date")]);
  expect(checkFontTable(undefined, expected)).toEqual([expect.stringContaining("missing")]);
});

test("injected readers produce deterministic rows and missing files or metadata fail loudly", () => {
  const read = {
    text: (file: string) => readers.text(file),
    bytes: () => new Uint8Array([1, 2, 3]),
  };
  expect(readFontFaces(read).every((row) => row.woff2Base64 === "AQID")).toBe(true);
  expect(renderFontTable([{
    family: "Inter", weight: 400, subset: "latin", unicodeRange: "U+0000-00FF", woff2Base64: "AQID",
  }])).toBe('import type { FontFace } from "./fonts";\n\nexport const FONT_FACES: readonly FontFace[] = [\n  {"family":"Inter","weight":400,"subset":"latin","unicodeRange":"U+0000-00FF","woff2Base64":"AQID"},\n];\n');
  expect(() => readFontFaces({ ...read, text: () => "" })).toThrow(/400.css: missing.*inter-latin-400/);
  expect(() => readFontFaces({ ...read, bytes: () => { throw new Error("missing woff2"); } })).toThrow("missing woff2");
  expect(() => readFontFaces({ ...read, bytes: () => new Uint8Array() })).toThrow("empty font file");
});
