import { readFileSync } from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { listThemes, parseResume, type Doc, type Resume } from "../src/lib/career/engine";
import { imagePng } from "../tests/career/engine/helpers/images";

export const PRINT_DAY = "2026-11-05";
export const PRINT_OPTIONS = { tagged: true, outline: true, timeoutMs: 30_000 };
export const PRINT_DOCUMENTS = listThemes().flatMap((theme) => [
  { theme, sample: "sample.en", doc: "resume" as Doc, key: `${theme}.sample.en` },
  { theme, sample: "sample.de", doc: "resume" as Doc, key: `${theme}.sample.de` },
  { theme, sample: "letter.de", doc: "letter" as Doc, key: `${theme}.letter.de` },
]);

export function sampleResume(directory: string, sample: string): Resume {
  const result = parseResume(readFileSync(path.join(directory, `${sample}.yaml`), "utf8"));
  if (!result.ok) throw new Error(`${sample}: ${JSON.stringify(result.issues)}`);
  return result.resume;
}

export function signaturePng(): Uint8Array {
  return imagePng(240, 80, (x, y) => {
    const stroke = 40 + 17 * Math.sin(x / 13) - x / 15;
    return x > 12 && x < 226 && Math.abs(y - stroke) < 2 ? [25, 35, 55, 255] : [255, 255, 255, 0];
  });
}

export async function normalizedText(pdf: Uint8Array): Promise<string> {
  const document = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  try {
    const { text } = await extractText(document, { mergePages: false });
    return text.join("\n").replace(/\s+/g, " ");
  } finally {
    await document.loadingTask.destroy();
  }
}
