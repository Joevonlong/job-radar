// @vitest-environment node
import path from "node:path";
import { inflateSync } from "node:zlib";
import { expect, test } from "vitest";
import { normalizedText, PRINT_DAY, PRINT_DOCUMENTS, sampleResume, signaturePng } from "../../e2e/career-print-samples";
import { listThemes } from "../../src/lib/career/engine";
import { checkOptions } from "./engine/helpers/check-options";
import { textPdf } from "./engine/helpers/pdf";

const fixtures = path.resolve(import.meta.dirname, "../fixtures/career");

test("shared print documents cover each theme and each fictional sample", () => {
  expect(PRINT_DAY).toBe("2026-11-05");
  expect(PRINT_DOCUMENTS).toHaveLength(15);
  expect(new Set(PRINT_DOCUMENTS.map((document) => document.key)).size).toBe(15);
  for (const theme of listThemes()) {
    expect(PRINT_DOCUMENTS.filter((document) => document.theme === theme).map(({ sample, doc }) => [sample, doc]))
      .toEqual([["sample.en", "resume"], ["sample.de", "resume"], ["letter.de", "letter"]]);
  }
  for (const { sample } of PRINT_DOCUMENTS) expect(sampleResume(fixtures, sample).basics.name).not.toBe("");
  expect(checkOptions(fixtures).limits.letterPages).toBeGreaterThan(0);
});

test("the generated signature is a real transparent PNG with a visible stroke", () => {
  const png = Buffer.from(signaturePng());
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([240, 80]);
  const compressed: Uint8Array[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(compressed));
  expect(pixels.length).toBe(80 * (1 + 240 * 4));
  let ink = 0;
  for (let y = 0; y < 80; y++) for (let x = 0; x < 240; x++) {
    if (pixels[y * (1 + 240 * 4) + 1 + x * 4 + 3]) ink++;
  }
  expect(ink).toBeGreaterThan(200);
  expect(ink).toBeLessThan(240 * 80 / 4);
});

test("normalization collapses whitespace while preserving digits and page order", async () => {
  const pdf = textPdf([["First 12  34"], ["Second 56 78"]]);
  expect((await normalizedText(pdf)).trim()).toBe("First 12 34 Second 56 78");
});
