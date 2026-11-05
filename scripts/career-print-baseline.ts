import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { normalizedText, PRINT_DAY, PRINT_DOCUMENTS, PRINT_OPTIONS, sampleResume, signaturePng } from "../e2e/career-print-samples";
import { renderResume } from "../src/lib/career/engine";
import { openPrinter } from "../src/lib/career/print/print-pdf";

export function firstDifference(expected: string, actual: string): string {
  let offset = 0;
  while (offset < Math.min(expected.length, actual.length) && expected[offset] === actual[offset]) offset++;
  const context = (text: string) => JSON.stringify(text.slice(Math.max(0, offset - 60), offset + 60));
  return `first differing offset: ${offset}\n  baseline: ${context(expected)}\n  output:   ${context(actual)}`;
}

function canonical(file: string): string {
  if (existsSync(file)) return realpathSync(file);
  return path.join(canonical(path.dirname(file)), path.basename(file));
}

export function assertOutputDirectory(out: string, baseline: string): void {
  const relative = path.relative(canonical(baseline), canonical(out));
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("--out must not be inside the print baseline directory");
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { fixtures: { type: "string" }, out: { type: "string" } }, strict: true });
  const fixtures = path.resolve(values.fixtures ?? path.join(import.meta.dirname, "../tests/fixtures/career"));
  const baseline = path.join(fixtures, "print-baseline");
  const out = path.resolve(values.out ?? mkdtempSync(path.join(tmpdir(), "career-print-")));
  assertOutputDirectory(out, baseline);
  mkdirSync(out, { recursive: true });
  const pagesFile = path.join(baseline, "pages.json");
  const baselinePages = existsSync(pagesFile) ? z.record(z.string(), z.number().int().positive()).parse(JSON.parse(readFileSync(pagesFile, "utf8"))) : {};
  const pages: Record<string, number> = {};
  let different = false;
  const printer = await openPrinter();
  try {
    for (const document of PRINT_DOCUMENTS) {
      const resume = sampleResume(fixtures, document.sample);
      const html = renderResume(resume, { theme: document.theme, doc: document.doc, today: PRINT_DAY, images: { signature: signaturePng() } });
      const result = await printer.print(html, PRINT_OPTIONS);
      const text = await normalizedText(result.pdf);
      pages[document.key] = result.pages;
      writeFileSync(path.join(out, `${document.key}.pdf`), result.pdf);
      writeFileSync(path.join(out, `${document.key}.txt`), text);
      const textFile = path.join(baseline, `${document.key}.txt`);
      if (!existsSync(textFile) || baselinePages[document.key] === undefined) {
        console.log(`${document.key}: no baseline`);
        continue;
      }
      const expected = readFileSync(textFile, "utf8");
      const same = expected === text && baselinePages[document.key] === result.pages;
      console.log(`${document.key}: ${same ? "same" : "different"}`);
      if (!same) {
        different = true;
        console.log(`  pages: baseline ${baselinePages[document.key]}, output ${result.pages}`);
        console.log(expected === text ? "  text equal; page count differs" : firstDifference(expected, text));
      }
    }
    writeFileSync(path.join(out, "pages.json"), `${JSON.stringify(pages, null, 2)}\n`);
  } finally {
    await printer.close();
  }
  console.log(`Output: ${out}`);
  return different ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
