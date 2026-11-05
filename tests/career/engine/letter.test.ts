// @vitest-environment node
import { expect, test } from "vitest";
import { parse, stringify } from "yaml";
import { fixture } from "./helpers/fixtures";
import { textPdf } from "./helpers/pdf";
import { imagePng } from "./helpers/images";
import { letterOrderProblem, lintLetter, missingLetterContent, runLetterCheck } from "../../../src/lib/career/engine/letter-check";
import { letterParts } from "../../../src/lib/career/engine/letter";
import { parseJd } from "../../../src/lib/career/engine/jd";
import { type Issue, lint } from "../../../src/lib/career/engine/lint";
import { exportStem } from "../../../src/lib/career/engine/naming";
import { plainLetter } from "../../../src/lib/career/engine/plain";
import { listThemes, parseResume, renderResume } from "../../../src/lib/career/engine/render";

const DAY = "2026-10-09";
const errorOf = (yaml: string) => {
  try {
    parseResume(yaml);
  } catch (e) {
    return (e as Error).message;
  }
  expect.unreachable("expected a schema error");
};
const BASICS = "basics: { name: Erika Muster, title: Engineer, location: Köln, email: e@example.com }\n";

const letter = (body: string[], extra = "", lang = "en") =>
  parseResume(`meta: { lang: ${lang} }\n${BASICS}target: { company: Acme GmbH }\nletter:\n  subject: Application\n  body: ${JSON.stringify(body)}\n${extra}`);
const words = (n: number, w = "work") => Array.from({ length: n }, () => w).join(" ");
const has = (issues: Issue[], re: RegExp) => issues.some((i) => re.test(i.message));

test("letter schema: body required and non-empty, real dates, no unknown keys; recipient may be one string", () => {
  expect(errorOf(`${BASICS}letter: { subject: S }\n`)).toMatch(/letter\.body/);
  expect(errorOf(`${BASICS}letter: { body: [] }\n`)).toMatch(/body needs at least one paragraph/);
  expect(errorOf(`${BASICS}letter: { body: [""] }\n`)).toMatch(/must not be empty/);
  expect(errorOf(`${BASICS}letter: { body: [a], date: 2026-13-01 }\n`)).toMatch(/expected a day|not a real calendar day/);
  expect(errorOf(`${BASICS}letter: { body: [a], greeting: Hi }\n`)).toMatch(/Unrecognized key|unrecognized/i);
  const r = parseResume(`${BASICS}letter: { recipient: Acme GmbH, body: [a] }\n`);
  expect(r.letter?.recipient).toEqual(["Acme GmbH"]);

  const de = letterParts(parseResume(`meta: { lang: de }\n${BASICS}letter: { body: [a] }\n`), DAY);
  expect([de.placeDate, de.salutation, de.closing]).toEqual(["Köln, 9. Oktober 2026", "Sehr geehrte Damen und Herren,", "Mit freundlichen Grüßen"]);
  const en = letterParts(parseResume(`${BASICS}letter: { body: [a], date: 2027-01-04, place: Bonn }\n`), DAY);
  expect([en.placeDate, en.salutation, en.closing]).toEqual(["Bonn, 4 January 2027", "Dear Hiring Team,", "Kind regards"]);
});

test("every theme renders the letter in reading order, without the portrait; a resume without a letter can't render one", async () => {
  const r = parseResume((fixture("letter.de.yaml")).replace("  pages: 1\n", "  pages: 1\n").replace("basics:\n", "basics:\n  photo: x.jpg\n"));
  for (const theme of listThemes()) {
    const html = renderResume(r, { theme, doc: "letter", today: DAY });
    expect(html.includes('data-doc="letter"') && html.includes('class="page letter"'), theme).toBeTruthy();
    expect(!html.includes('class="photo"'), `${theme}: no portrait on the letter`).toBeTruthy();
    const order = ["Lena Hartmann", "Personalabteilung", "Berlin, 9. Oktober 2026", "Kennziffer 4711", "Sehr geehrte Frau Muster,", "in Ihrer Ausschreibung", "Mit freundlichen Grüßen"];
    const body = html.slice(html.indexOf("<body"));
    const at = order.map((s) => body.indexOf(s));
    expect([...at].sort((a, b) => a - b), `${theme}: DOM order = reading order`).toEqual(at);
    expect(at.every((i) => i >= 0), theme).toBeTruthy();
    expect(!/position:\s*(absolute|relative)|float:/.test(body), theme).toBeTruthy();
  }
  expect(() => renderResume(parseResume(BASICS), { doc: "letter", today: DAY })).toThrow(/career\.letter\.missing/);

  const plain = parseResume(stringify({ ...parse(fixture("letter.de.yaml")), letter: undefined }));
  expect((await renderResume(r, { today: DAY, theme: "minimal" })).replace(/<img class="photo"[^>]*>/, "")).toBe((await renderResume({ ...plain, basics: { ...plain.basics, photo: "x.jpg" } }, { today: DAY, theme: "minimal" })).replace(/<img class="photo"[^>]*>/, ""));
});

test("letter file names: Anschreiben / Cover_Letter with the company; meta.filename only names the CV", () => {
  const de = parseResume(`meta: { lang: de, filename: "{name}_CV_{company}" }\nbasics: { name: Lena Müller, title: T }\ntarget: { company: Acme GmbH }\nletter: { body: [a] }\n`);
  expect(exportStem(de, DAY, "letter")).toBe("Lena_Mueller_Anschreiben_Acme-GmbH");
  expect(exportStem(de, DAY)).toBe("Lena_Mueller_CV_Acme-GmbH");
  expect(exportStem(parseResume(`basics: { name: Lena Hartmann, title: T }\nletter: { body: [a] }\n`), DAY, "letter")).toBe("Lena_Hartmann_Cover_Letter");
});

test("letter lint: length, stock openers, company named, placeholders and filler — both directions", () => {
  const good = [`At Acme GmbH you build document agents; ${words(120)}.`, words(110)];
  const ok = lintLetter(letter(good));
  expect(!has(ok, /words —|stock opener|never names|placeholder|filler/), JSON.stringify(ok)).toBeTruthy();
  expect(has(lintLetter(letter(["At Acme I build agents.", words(50)])), /has \d+ words — under 200/)).toBeTruthy();
  expect(has(lintLetter(letter([`At Acme ${words(300)}`, words(200)])), /has \d+ words — over 450/)).toBeTruthy();
  expect(has(lintLetter(letter(["Hiermit bewerbe ich mich bei Acme als Engineer.", words(220)], "", "de")), /stock opener "Hiermit bewerbe ich mich"/)).toBeTruthy();
  expect(has(lintLetter(letter(["I am writing to apply for the role at Acme.", words(220)])), /stock opener/)).toBeTruthy();
  expect(!has(lintLetter(letter(["Hiermit zeige ich, warum Acme passt.", words(220)], "", "de")), /stock opener/)).toBeTruthy();

  expect(has(lintLetter(letter([words(220)])), /never names Acme GmbH/)).toBeTruthy();
  expect(!has(lintLetter(letter([`Bei ACME ${words(220)}`])), /never names/)).toBeTruthy();
  const noTarget = parseResume(`${BASICS}letter:\n  recipient: [Beispiel AG, Personal]\n  body: ["${words(220)}"]\n`);
  expect(has(lintLetter(noTarget), /never names Beispiel AG/)).toBeTruthy();

  expect(lintLetter(letter([`Acme ⟨why this company⟩ ${words(220)}`])).find((i) => /placeholder/.test(i.message))?.level).toBe("error");
  expect(has(lintLetter(letter([`I am passionate about Acme. ${words(220)}`])), /filler wording: passionate/)).toBeTruthy();
  expect(has(lintLetter(parseResume(`${BASICS}letter: { body: ["${words(220)}"] }\n`)), /no subject line/)).toBeTruthy();

  expect(!lint(letter([`Acme ⟨why⟩ TODO ${words(220)}`])).some((i) => i.where.startsWith("letter"))).toBeTruthy();
});

test("letter lint: placeholders first; the letter's language against meta.lang (language rules applied to the letter)", () => {
  const draft = lintLetter(letter([`I am passionate about Acme ⟨why⟩. ${words(20)}`]));
  expect(draft.map((i) => i.level), JSON.stringify(draft)).toEqual(["error", "info"]);
  expect(draft[1].message).toMatch(/fill them in first/);
  const german = "Bei der Acme GmbH möchte ich mit meiner Erfahrung in der Entwicklung von Agenten und mit Evals für die Produkte des Teams arbeiten, das ist auch für mich ein Ziel.";
  const de = [german, `${german} Die Arbeit an der Plattform ist mir wichtig und ich bin mit der Technik vertraut.`];
  expect(lintLetter(letter(de)).find((i) => i.where === "meta.lang")?.level).toBe("error");
  expect(!lintLetter(letter(de, "", "de")).some((i) => i.where === "meta.lang")).toBeTruthy();
  expect(!lintLetter(letter([`At Acme the team builds agents and evals for the product, and that is the work I do. ${words(200)}`])).some((i) => i.where === "meta.lang")).toBeTruthy();
});

test("letter lint with a JD: salary and start date asked but not answered (warn), answered (quiet), not asked (quiet)", () => {
  const body = (s: string) => letter([`At Acme ${words(210)}. ${s}`]);
  const jd = (s: string) => ({ jd: parseJd(`# Engineer\n\n${s}\n`) });
  const asks = jd("Bitte senden Sie uns Ihre Unterlagen mit Gehaltsvorstellung und frühestmöglichem Eintrittstermin.");
  const both = lintLetter(body("I look forward to talking."), asks);
  expect(has(both, /salary expectation .* names no figure/) && has(both, /asks when you can start/), JSON.stringify(both)).toBeTruthy();
  for (const answer of ["Meine Gehaltsvorstellung liegt bei 78.000 € brutto; ich kann ab 01/2027 beginnen.", "I expect EUR 75,000 and can start from March 2027.", "Salary: 80k EUR; notice period of three months."])
    expect(!has(lintLetter(body(answer), asks), /names no figure|asks when you can start/), answer).toBeTruthy();
  const sre = lintLetter(body("Nothing about money."), jd("You run high availability systems with Kubernetes."));
  expect(!has(sre, /names no figure|asks when you can start/), "“high availability” is not a start date").toBeTruthy();
});

test("letter reading order and completeness on synthetic text layers", () => {
  const r = letter(["First paragraph about Acme and the agent work we did.", "Second paragraph with the numbers that prove it."], "  recipient: [Acme GmbH, HR]\n  date: 2026-10-09\n");
  const l = letterParts(r, DAY);
  const ok = "Erika Muster\nEngineer\nKöln · e@example.com\nAcme GmbH\nHR\nKöln, 9 October 2026\nApplication\nDear Hiring Team,\nFirst paragraph about Acme and the agent\nwork we did.\nSecond paragraph with the numbers that prove it.\nKind regards\nErika Muster\n";
  expect(letterOrderProblem(r, ok, l)).toBe(null);
  expect(missingLetterContent(r, ok, l)).toEqual([]);
  const swapped = ok.replace("Application\nDear Hiring Team,\n", "Dear Hiring Team,\nApplication\n");
  expect(letterOrderProblem(r, swapped, l)!).toMatch(/^letter\.salutation: out of order/);
  const lost = ok.replace("Second paragraph with the numbers that prove it.\n", "");
  expect(letterOrderProblem(r, lost, l)!).toMatch(/^letter\.body\[1\]: not extractable/);
  expect(missingLetterContent(r, lost, l).map((i) => [i.level, i.where])).toEqual([["error", "letter.body[1]"]]);
});

test("letter check on text PDFs: complete letter passes; two pages and missing signature fail", async () => {
  const r = parseResume(fixture("letter.de.yaml"));
  const lines = plainLetter(r, DAY).trimEnd().split("\n");
  const res = await runLetterCheck(r, textPdf([lines]), { images: { signature: imagePng() }, today: DAY });
  expect(res.ok, JSON.stringify(res.issues.filter((i) => i.level === "error"))).toBe(true);
  expect([res.pages, res.budget, res.readingOrder, res.parser]).toEqual([1, 1, null, []]);
  expect(res.text.split("\n")[0]).toMatch(/^Lena Hartmann/);
  r.letter!.signature = "missing-signature.png";
  const bad = await runLetterCheck(r, textPdf([lines, ["Extra page"]]), { today: DAY });
  expect(bad.ok).toBe(false);
  expect(bad.pages).toBe(2);
  expect(bad.issues[0].level).toBe("error");
  expect(bad.lint.find((i) => i.where === "letter.signature")!.message).toMatch(/"missing-signature\.png" doesn't exist/);
  expect(!renderResume(r, { doc: "letter", today: DAY }).includes('class="l-sig"')).toBeTruthy();
  const unreadable = await runLetterCheck(r, textPdf([lines]), { images: { signature: new Uint8Array([1]) }, today: DAY });
  expect(unreadable.lint.some((i) => i.where === "letter.signature")).toBeTruthy();
});

test("plain-text letter: sender, recipient, Ort/Datum, subject, paragraphs without markup, closing, name", async () => {
  const txt = plainLetter(parseResume(fixture("letter.de.yaml")), DAY);
  expect(txt).toMatch(/^Lena Hartmann\nMusterstraße 12\n10115 Berlin\n\+49 30 0000000 \| lena\.hartmann@example\.com\n\nExample GmbH\nPersonalabteilung\n/);
  expect(txt).toMatch(/\n\nBerlin, 9\. Oktober 2026\n\nBewerbung als Senior AI Engineer \(m\/w\/d\) – Kennziffer 4711\n\nSehr geehrte Frau Muster,\n\nin Ihrer Ausschreibung/);
  expect(txt.includes("den über 40 Unternehmenskunden einsetzen") && !txt.includes("**")).toBeTruthy();
  expect(txt).toMatch(/\n\nMit freundlichen Grüßen\n\nLena Hartmann\n$/);
});
