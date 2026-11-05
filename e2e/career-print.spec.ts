import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDocumentProxy, getResolvedPDFJS } from "unpdf";
import { z } from "zod";
import { test as base, expect } from "./fixtures";
import { normalizedText, PRINT_DAY, PRINT_DOCUMENTS, PRINT_OPTIONS, sampleResume, signaturePng } from "./career-print-samples";
import { extractText, renderResume, runCheck, runLetterCheck, shipBlockers, shownContent, type Doc, type Resume } from "../src/lib/career/engine";
import { missingContent, parserProblems, readingOrderProblem } from "../src/lib/career/engine/extract";
import { plainText } from "../src/lib/career/engine/sections";
import { THEMES } from "../src/lib/career/engine/themes";
import { openPrinter, type Printer } from "../src/lib/career/print/print-pdf";
import { checkOptions } from "../tests/career/engine/helpers/check-options";

const FIXTURES = path.resolve(import.meta.dirname, "../tests/fixtures/career");
const BASELINE = path.join(FIXTURES, "print-baseline");
const OPTIONS = { ...checkOptions(FIXTURES), today: PRINT_DAY, images: { signature: signaturePng() } };
const WORD = /[\p{L}]{5,}/gu;
/** Line-end hyphenation can split a few compounds; garbled output splits many more words. */
const MAX_MISSING_WHOLE_WORDS = 3;
/** Chromium rounds metric paper sizes to device pixels before writing PDF points. */
const PAPER_SIZE_TOLERANCE_PT = 1;

const test = base.extend<Record<never, never>, { printer: Printer }>({
  printer: [async ({}, usePrinter) => {
    const printer = await openPrinter();
    try { await usePrinter(printer); } finally { await printer.close(); }
  }, { scope: "worker" }],
});

function html(resume: Resume, theme = resume.meta.theme, doc: Doc = "resume", signature = true): string {
  return renderResume(resume, { theme, doc, today: PRINT_DAY, images: signature ? OPTIONS.images : undefined });
}

function assertWholeWords(text: string, resume: Resume, doc: Doc, extractor: string): void {
  const source = doc === "letter" ? [resume.basics.name, ...(resume.letter?.body ?? [])] : [resume.basics.name, ...shownContent(resume, PRINT_DAY).map((part) => part.text)];
  const expected = new Set(source.flatMap((part) => plainText(part).match(WORD) ?? []).map((word) => word.toLowerCase()));
  const actual = new Set((text.match(WORD) ?? []).map((word) => word.toLowerCase()));
  const missing = [...expected].filter((word) => !actual.has(word));
  expect(expected.size).toBeGreaterThan(0);
  expect(missing.length, `${extractor}: ${missing.join(", ")}`).toBeLessThanOrEqual(MAX_MISSING_WHOLE_WORDS);
  expect(text, extractor).toContain(resume.basics.name);
}

async function sheetSizes(pdf: Uint8Array): Promise<number[][]> {
  const document = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  try {
    const sizes: number[][] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push([viewport.width, viewport.height]);
      page.cleanup();
    }
    return sizes;
  } finally {
    await document.loadingTask.destroy();
  }
}

for (const document of PRINT_DOCUMENTS) {
  test(`${document.key}: pages match the baseline on every OS`, async ({ printer }) => {
    const pages = z.record(z.string(), z.number().int().positive()).parse(JSON.parse(readFileSync(path.join(BASELINE, "pages.json"), "utf8")));
    expect(pages[document.key], "every document needs a baseline page count").toBeDefined();
    const result = await printer.print(html(sampleResume(FIXTURES, document.sample), document.theme, document.doc), PRINT_OPTIONS);
    expect(result.pages).toBe(pages[document.key]);
  });

  test(`${document.key}: exact Linux text matches the baseline`, async ({ printer }) => {
    test.skip(process.platform !== "linux", "The text layer differs between operating systems; the baseline is Linux.");
    const result = await printer.print(html(sampleResume(FIXTURES, document.sample), document.theme, document.doc), PRINT_OPTIONS);
    expect(await normalizedText(result.pdf)).toBe(readFileSync(path.join(BASELINE, `${document.key}.txt`), "utf8"));
  });

  test(`${document.key}: real PDF checks contain no errors`, async ({ printer }) => {
    const resume = sampleResume(FIXTURES, document.sample);
    const { pdf } = await printer.print(html(resume, document.theme, document.doc), PRINT_OPTIONS);
    const result = await (document.doc === "letter" ? runLetterCheck : runCheck)(resume, pdf, OPTIONS);
    expect(result.issues.filter((issue) => issue.level === "error")).toEqual([]);
  });

  test(`${document.key}: extractors preserve whole words`, async ({ printer }, testInfo) => {
    const resume = sampleResume(FIXTURES, document.sample);
    const { pdf } = await printer.print(html(resume, document.theme, document.doc), PRINT_OPTIONS);
    assertWholeWords(await normalizedText(pdf), resume, document.doc, "unpdf");
    const probe = spawnSync("pdftotext", ["-v"], { stdio: "ignore" });
    if (probe.error && "code" in probe.error && probe.error.code === "ENOENT") {
      testInfo.annotations.push({ type: "extractor", description: "pdftotext is not on PATH; unpdf whole-word assertions ran." });
      return;
    }
    if (probe.error) throw probe.error;
    expect(probe.status, "pdftotext must be usable when installed").toBe(0);
    const directory = await mkdtemp(path.join(tmpdir(), "career-words-"));
    try {
      const file = path.join(directory, "resume.pdf");
      await writeFile(file, pdf);
      const text = execFileSync("pdftotext", ["-raw", "-enc", "UTF-8", file, "-"], { encoding: "utf8", timeout: PRINT_OPTIONS.timeoutMs });
      assertWholeWords(text, resume, document.doc, "pdftotext -raw");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("printer isolation blocks external resources and scripts with a working control", async ({ printer, browser }) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/image.png") {
      response.setHeader("Content-Type", "image/png");
      response.end(signaturePng());
    } else {
      response.setHeader("Content-Type", "text/javascript");
      response.end('document.body.append(" External script ran ");');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const hostile = `<!doctype html><body><p>Original printable text</p><img src="${origin}/image.png"><script>document.body.append(" Inline script ran ");</script><script src="${origin}/probe.js"></script></body>`;
  try {
    const isolated = await printer.print(hostile, PRINT_OPTIONS);
    expect(isolated.pages).toBeGreaterThan(0);
    expect(requests).toBe(0);
    const text = await normalizedText(isolated.pdf);
    expect(text).toContain("Original printable text");
    expect(text).not.toContain("Inline script ran");
    expect(text).not.toContain("External script ran");
    const context = await browser.newContext({ javaScriptEnabled: true });
    try {
      const page = await context.newPage();
      await page.setContent(hostile, { waitUntil: "load" });
      const control = await normalizedText(new Uint8Array(await page.pdf()));
      expect(requests).toBeGreaterThan(0);
      expect(control).toContain("Inline script ran");
      expect(control).toContain("External script ran");
    } finally { await context.close(); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("every printed sample embeds its used theme families without fallback fonts", async ({ printer }) => {
  test.setTimeout(180_000);
  const { OPS } = await getResolvedPDFJS();
  const normalize = (family: string) => family.replace(/^[A-Z]{6}\+/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  for (const sample of PRINT_DOCUMENTS) {
    const { pdf } = await printer.print(html(sampleResume(FIXTURES, sample.sample), sample.theme, sample.doc), PRINT_OPTIONS);
    const document = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0, fontExtraProperties: true });
    try {
      const names = new Set<string>();
      for (let n = 1; n <= document.numPages; n++) {
        const page = await document.getPage(n);
        const operators = await page.getOperatorList();
        for (let i = 0; i < operators.fnArray.length; i++) if (operators.fnArray[i] === OPS.setFont) {
          const [id] = z.tuple([z.string(), z.number()]).parse(operators.argsArray[i]);
          const font = z.object({ name: z.string(), data: z.instanceof(Uint8Array) }).parse(page.commonObjs.get(id));
          expect(font.data.length, `${sample.key}: embedded font ${font.name}`).toBeGreaterThan(0);
          names.add(normalize(font.name));
        }
        page.cleanup();
      }
      const families = [...new Set(THEMES[sample.theme].template.fonts.map((font) => normalize(font.family)))];
      expect(names.size, sample.key).toBeGreaterThan(0);
      for (const name of names) expect(families.some((family) => name.startsWith(family)), `${sample.key}: unexpected font ${name}`).toBe(true);
      // Classic uses proportional stacks; minimal and band letters have neither stacks nor inline code.
      const usesMono = sample.theme !== "classic" && (sample.doc !== "letter" || ["compact", "split"].includes(sample.theme));
      const used = families.filter((family) => usesMono || family !== normalize("IBM Plex Mono"));
      for (const family of used) expect([...names].some((name) => name.startsWith(family)), `${sample.key}: missing ${family}`).toBe(true);
    } finally { await document.loadingTask.destroy(); }
  }
});

test("minimal tagged PDF starts with the name and passes the parser in reading order", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  const { pdf } = await printer.print(html(resume, "minimal"), PRINT_OPTIONS);
  const result = await runCheck(resume, pdf, OPTIONS);
  expect(result.parser).toEqual([]);
  expect(result.readingOrder).toBeNull();
  expect(result.text.startsWith(resume.basics.name)).toBe(true);
  expect(result.ok).toBe(true);
});

test("split prints education bullets and inline code punctuation; compact keeps headings whole", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  resume.education[0].bullets.push("Teaching assistant for databases.");
  resume.experience[0].bullets.push("Built services and `Go`. See blog.");
  const split = await extractText((await printer.print(html(resume, "split"), PRINT_OPTIONS)).pdf);
  expect(missingContent(resume, split, PRINT_DAY, OPTIONS.limits)).toEqual([]);
  expect(split.replace(/\s+/g, " ")).toContain("Teaching assistant for databases.");
  expect(split).toContain("services and Go. See blog.");
  const sample = sampleResume(FIXTURES, "sample.en");
  const compact = await extractText((await printer.print(html(sample, "compact"), PRINT_OPTIONS)).pdf);
  expect(parserProblems(sample, compact)).toEqual([]);
  expect(compact).toMatch(/^LANGUAGES$/m);
});

test("numbers stay with their units in HTML and retain ordinary spaces in the text layer", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  const bullet = "Cut p95 latency from 820 ms to 210 ms and cost by 40 % for 3 TB a day";
  resume.experience[0].bullets = [bullet];
  const content = html(resume);
  expect(content).toContain("820\u00a0ms");
  expect(content).toContain("40\u00a0%");
  expect(resume.experience[0].bullets[0]).toBe(bullet);
  const result = await runCheck(resume, (await printer.print(content, PRINT_OPTIONS)).pdf, OPTIONS);
  expect(result.text).toMatch(/820 ms to 210 ms and cost by 40 % for 3 TB/);
  expect(result.parser).toEqual([]);
});

test("shipping blocks placeholders in a real printed document and accepts the finished sample", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  const finished = await printer.print(html(resume), PRINT_OPTIONS);
  expect(shipBlockers(resume, "resume", { limits: OPTIONS.limits, pages: finished.pages })).toEqual([]);
  resume.basics.summary = "⟨One sentence about you⟩";
  const unfinished = await printer.print(html(resume), PRINT_OPTIONS);
  expect(shipBlockers(resume, "resume", { limits: OPTIONS.limits, pages: unfinished.pages }).map((issue) => issue.code)).toContain("career.gate.placeholders");
});

test("a two-page resume has two A4 sheets", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  resume.meta.pages = 2;
  resume.experience = [...resume.experience, ...resume.experience, ...resume.experience];
  const result = await printer.print(html(resume), PRINT_OPTIONS);
  expect(result.pages).toBe(2);
  const sizes = await sheetSizes(result.pdf);
  expect(sizes).toHaveLength(2);
  for (const [width, height] of sizes) {
    expect(Math.abs(width - 210 / 25.4 * 72)).toBeLessThanOrEqual(PAPER_SIZE_TOLERANCE_PT);
    expect(Math.abs(height - 297 / 25.4 * 72)).toBeLessThanOrEqual(PAPER_SIZE_TOLERANCE_PT);
  }
});

test("the second-page folio occupies its own line and preserves reading order", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  resume.experience = Array.from({ length: 8 }, () => resume.experience).flat();
  const { pdf, pages } = await printer.print(html(resume), PRINT_OPTIONS);
  expect(pages).toBeGreaterThanOrEqual(2);
  const text = await extractText(pdf);
  expect(text.split("\n").map((line) => line.trim())).toContain(`2 / ${pages}`);
  expect(readingOrderProblem(resume, text)).toBeNull();
});

test("a Letter-paper resume occupies one Letter sheet without A4 padding", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "sample.en");
  resume.meta.paper = "letter";
  const { pdf, pages } = await printer.print(html(resume), PRINT_OPTIONS);
  expect(pages).toBe(1);
  expect(await sheetSizes(pdf)).toEqual([[612, 792]]);
});

for (const theme of Object.keys(THEMES)) {
  test(`${theme}: sections preserve text, tags, custom headings and quiet-mode pages`, async ({ printer }) => {
    const resume = sampleResume(FIXTURES, "sections.en");
    const accent = await printer.print(html(resume, theme), PRINT_OPTIONS);
    const text = await extractText(accent.pdf);
    resume.meta.colors = "quiet";
    const quiet = await printer.print(html(resume, theme), PRINT_OPTIONS);
    expect(quiet.pages).toBe(accent.pages);
    expect(await extractText(quiet.pdf)).toBe(text);
    expect(text.split("\n")[0].trim()).toBe(resume.basics.name);
    expect(readingOrderProblem(resume, text)).toBeNull();
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("Developer experience · Reliability · Cost · Security · Observability");
    expect(flat).toContain("Go · CLI · OSS");
    expect(flat).toMatch(/\bWork Experience\b/i);
  });
}

test("real letter checks accept the signed example and reject two pages with a missing signature", async ({ printer }) => {
  const resume = sampleResume(FIXTURES, "letter.de");
  const good = await runLetterCheck(resume, (await printer.print(html(resume, "split", "letter"), PRINT_OPTIONS)).pdf, OPTIONS);
  expect(good.ok).toBe(true);
  expect([good.pages, good.budget, good.readingOrder, good.parser]).toEqual([1, 1, null, []]);
  expect(good.text.split("\n")[0]).toMatch(new RegExp(`^${resume.basics.name}`));
  resume.letter!.body = [...resume.letter!.body, ...resume.letter!.body, ...resume.letter!.body];
  resume.letter!.signature = "missing-signature.png";
  const content = html(resume, resume.meta.theme, "letter", false);
  const bad = await runLetterCheck(resume, (await printer.print(content, PRINT_OPTIONS)).pdf, { ...OPTIONS, images: undefined });
  expect(bad.ok).toBe(false);
  expect(bad.pages).toBe(2);
  expect(bad.issues[0].level).toBe("error");
  expect(bad.lint).toContainEqual(expect.objectContaining({ where: "letter.signature", code: "career.check.signature_unreadable", level: "error" }));
  expect(content).not.toContain('class="l-sig"');
});
