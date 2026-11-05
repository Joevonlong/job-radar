import { compileLexicon } from "./compile-lexicon";
import type { CheckLexicon } from "./lexicon";
import type { CheckLimits } from "./limits";
import type { Diagnostic, Issue } from "./finding";
import { type CheckResult, type Finding, signatureIssue } from "./check";
import { countPages, canon, extractPages, identityProblems, present, withoutFolios } from "./extract";
import type { Jd } from "./jd";
import { letterParts, letterSignaturePath, type LetterParts } from "./letter";
import { PLACEHOLDER, proseLanguage } from "./lint";
import type { Images } from "./images";
import type { Resume } from "./schema";
import { plainText } from "./sections";

const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function sequence(r: Resume, l: LetterParts): { where: string; text: string }[] {
  return [
    ...l.recipient.map((text, i) => ({ where: `letter.recipient${l.recipient.length > 1 ? `[${i}]` : ""}`, text })),
    { where: r.letter?.date ? "letter.date" : "letter.place", text: l.placeDate },
    ...(l.subject ? [{ where: "letter.subject", text: plainText(l.subject) }] : []),
    { where: "letter.salutation", text: l.salutation },
    ...l.body.map((p, i) => ({ where: `letter.body[${i}]`, text: plainText(p) })),
    { where: "letter.closing", text: l.closing },
  ];
}

export function letterOrderProblem(r: Resume, text: string, l: LetterParts): Diagnostic | null {
  const hay = squash(text);
  let at = 0;
  for (const { where, text: part } of [{ where: "basics.name", text: r.basics.name }, ...sequence(r, l), { where: "signer", text: l.signer }]) {
    const s = squash(part).slice(0, 40);
    if (!s) continue;
    const i = hay.indexOf(s, at);
    if (i < 0) return { code: hay.includes(s) ? "career.letter.order_wrong" : "career.letter.order_missing", params: { where, text: `${part.slice(0, 40).trim()}…` } };
    at = i + s.length;
  }
  return null;
}

export function missingLetterContent(r: Resume, text: string, l: LetterParts, limits: CheckLimits): Issue[] {
  const hay = canon(withoutFolios(text));
  return sequence(r, l).flatMap(({ where, text: part }): Issue[] => {
    const needle = canon(part);
    if (!needle || present(hay, needle, limits)) return [];
    const short = part.replace(/\s+/g, " ").trim();
    return [{ level: "error", where, code: "career.letter.content_missing", params: { text: short.length > 60 ? `${short.slice(0, 57)}…` : short } }];
  });
}

const SAYS_SALARY = /\d[\d.,  ]*\s*(?:k|tsd\.?|t)?\s*(?:€|eur\b|euro)|(?:€|eur\b)\s*\d|\b\d{2,3}\s?k\b/i;
const MONTHS = "januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december";

const SAYS_START = new RegExp(
  `\\b(?:ab|zum|from|starting|available)\\s+(?:sofort|immediately|now|(?:dem\\s+)?\\d|(?:anfang|mitte|ende|early|mid|end\\s+of)\\b|(?:${MONTHS})\\b)|kündigungsfrist|notice\\s+period|eintrittstermin|start(?:ing)?\\s+date|\\b(?:0?[1-9]|1[0-2])\\/\\d{4}\\b|\\b\\d{1,2}\\.\\s?\\d{1,2}\\.\\s?\\d{4}\\b|\\bsofort\\b|\\bimmediately\\b`,
  "iu",
);

function strings(value: unknown, path: string): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

export function letterPlaceholders(r: Resume): Issue[] {
  if (!r.letter) return [];
  return [...strings(r.letter, "letter"), ...strings(r.basics, "basics")]
    .filter(({ text }) => PLACEHOLDER.test(text))
    .map(({ path, text }): Issue => ({ level: "error", where: path, code: "career.lint.placeholder", params: { text: text.slice(0, 70) } }));
}

export function lintLetter(r: Resume, opts: { limits: CheckLimits; lexicon: CheckLexicon; jd?: Jd }): Issue[] {
  const l = r.letter;
  if (!l) return [];
  const { limits } = opts;
  const lexicon = compileLexicon(opts.lexicon);
  const companyCore = (s: string) => s.replace(lexicon.letterLegal, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const out: Issue[] = [];
  const add = (level: Issue["level"], where: string, code: string, params?: Diagnostic["params"]) => out.push({ level, where, code, ...(params ? { params } : {}) });

  const placeholders = letterPlaceholders(r);
  if (placeholders.length)
    return [
      ...placeholders,
      { level: "info", where: "placeholders", code: "career.letter.placeholders", params: { count: placeholders.length } },
    ];

  for (const { path, text } of [...(l.subject ? [{ path: "letter.subject", text: l.subject }] : []), ...l.body.map((text, i) => ({ path: `letter.body[${i}]`, text }))]) {
    const filler = [...new Set(text.match(lexicon.filler)?.map((w) => w.toLowerCase()))];
    if (filler.length) add("warn", path, "career.lint.filler", { terms: filler.join(", ") });
  }
  if (!l.subject) add("info", "letter.subject", "career.letter.subject_missing");

  const body = l.body.map(plainText).join("\n");

  const { reads, clear } = proseLanguage(body, limits, lexicon);
  if (reads && reads !== r.meta.lang)
    add(clear ? "error" : "warn", "meta.lang", "career.letter.language_mismatch", { lang: r.meta.lang, reads });
  const words = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words < limits.letterWords.min) add("info", "letter.body", "career.letter.words_short", { count: words, min: limits.letterWords.min });
  else if (words > limits.letterWords.max) add("info", "letter.body", "career.letter.words_long", { count: words, max: limits.letterWords.max });

  l.body.forEach((p, i) => {
    const stock = plainText(p).match(lexicon.stockOpener)?.[0];
    if (stock) add("info", `letter.body[${i}]`, "career.letter.stock_opener", { text: stock });
  });

  const company = r.target?.company ?? l.recipient?.[0];
  if (company && companyCore(company) && !companyCore(body).includes(companyCore(company)))
    add("warn", "letter.body", "career.letter.company_missing", { company });

  if (opts.jd) {
    const ask = opts.jd.text;
    const salary = ask.match(lexicon.asksSalary)?.[0];
    if (salary && !SAYS_SALARY.test(body))
      add("warn", "letter.body", "career.letter.salary_missing", { quote: salary });
    const start = ask.match(lexicon.asksStart)?.[0];
    if (start && !SAYS_START.test(body))
      add("warn", "letter.body", "career.letter.start_missing", { quote: start });
  }
  return out;
}

export async function runLetterCheck(r: Resume, pdf: Uint8Array, opts: { today: string; limits: CheckLimits; lexicon: CheckLexicon; jd?: Jd; images?: Images }): Promise<CheckResult> {
  const { limits } = opts;
  const l = letterParts(r, opts.today);
  const pages = await countPages(pdf);
  const pageTexts = await extractPages(pdf);
  const text = pageTexts.join("");
  const readingOrder = letterOrderProblem(r, text, l);
  const parser = [...identityProblems(r, text), ...missingLetterContent(r, text, l, limits)];
  const where = r.letter?.signature ? "letter.signature" : "meta.signature.image";
  const issues = [...signatureIssue(letterSignaturePath(r), where, opts.images?.signature), ...lintLetter(r, opts)];
  const over = pages > limits.letterPages;
  const all: Finding[] = [
    { level: over ? "error" : "ok", where: "pages", code: "career.check.pages", params: { pages, budget: limits.letterPages } },
    { level: readingOrder ? "error" : "ok", where: "reading_order", ...(readingOrder ?? { code: "career.letter.order_ok" }) },
    ...(parser.length ? parser : [{ level: "ok" as const, where: "parser_view", code: "career.letter.parser_ok" }]),
    ...issues,
  ];
  const ok = !over && !readingOrder && ![...parser, ...issues].some((i) => i.level === "error");
  const landmarks: CheckResult["landmarks"] = [{ kind: "name", text: r.basics.name }];
  for (const key of ["email", "phone"] as const) if (r.basics[key]) landmarks.push({ kind: key, text: r.basics[key]! });
  return { ok, pages, budget: limits.letterPages, readingOrder, parser, lint: issues, text, pageTexts, landmarks, issues: all };
}
