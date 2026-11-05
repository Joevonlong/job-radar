import { type CheckResult, type Finding, signatureIssue } from "./check";
import { countPages, canon, extractPages, identityProblems, present, withoutFolios } from "./extract";
import { today as localToday } from "./i18n";
import type { Jd } from "./jd";
import { letterParts, letterSignaturePath, type LetterParts } from "./letter";
import { FILLER_RE, type Issue, PLACEHOLDER, proseLanguage } from "./lint";
import type { Images } from "./images";
import type { Resume } from "./schema";
import { plainText } from "./sections";

export const LETTER_PAGES = 1;

export const LETTER_WORDS = { min: 200, max: 450 };

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

export function letterOrderProblem(r: Resume, text: string, l: LetterParts): string | null {
  const hay = squash(text);
  let at = 0;
  for (const { where, text: part } of [{ where: "basics.name", text: r.basics.name }, ...sequence(r, l), { where: "signer", text: l.signer }]) {
    const s = squash(part).slice(0, 40);
    if (!s) continue;
    const i = hay.indexOf(s, at);
    if (i < 0) return `${where}: ${hay.includes(s) ? "out of order" : "not extractable"}: "${part.slice(0, 40).trim()}…"`;
    at = i + s.length;
  }
  return null;
}

export function missingLetterContent(r: Resume, text: string, l: LetterParts): Issue[] {
  const hay = canon(withoutFolios(text));
  return sequence(r, l).flatMap(({ where, text: part }): Issue[] => {
    const needle = canon(part);
    if (!needle || present(hay, needle)) return [];
    const short = part.replace(/\s+/g, " ").trim();
    return [{ level: "error", where, message: `"${short.length > 60 ? `${short.slice(0, 57)}…` : short}" is not in the PDF text layer — the theme didn't print it, so no reader sees it` }];
  });
}

const LEGAL = /\b(gmbh(?:\s*&\s*co\.?\s*kg)?|mbh|ag|se|kg(?:aa)?|ohg|e\.\s?v\.|inc\.?|ltd\.?|llc|plc|corp\.?|co\.)(?=\s|$)/gi;
const companyCore = (s: string) => s.replace(LEGAL, " ").replace(/\s+/g, " ").trim().toLowerCase();

const ASKS_SALARY = /gehaltsvorstellung|gehaltswunsch|gehaltsvorstellungen|gehaltsangabe|salary\s+(?:expectation|requirement)s?|desired\s+salary|expected\s+salary|compensation\s+expectations?/i;
const ASKS_START = /eintrittstermin|eintrittsdatum|starttermin|frühestmöglich|start(?:ing)?\s+date|earliest\s+(?:possible\s+)?start|notice\s+period|kündigungsfrist/i;

const SAYS_SALARY = /\d[\d.,  ]*\s*(?:k|tsd\.?|t)?\s*(?:€|eur\b|euro)|(?:€|eur\b)\s*\d|\b\d{2,3}\s?k\b/i;
const MONTHS = "januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|january|february|march|may|june|july|october|december";

const SAYS_START = new RegExp(
  `\\b(?:ab|zum|from|starting|available)\\s+(?:sofort|immediately|now|(?:dem\\s+)?\\d|(?:anfang|mitte|ende|early|mid|end\\s+of)\\b|(?:${MONTHS})\\b)|kündigungsfrist|notice\\s+period|eintrittstermin|start(?:ing)?\\s+date|\\b(?:0?[1-9]|1[0-2])\\/\\d{4}\\b|\\b\\d{1,2}\\.\\s?\\d{1,2}\\.\\s?\\d{4}\\b|\\bsofort\\b|\\bimmediately\\b`,
  "iu",
);

const STOCK_OPENER = /hiermit\s+(?:bewerbe\s+ich\s+mich|möchte\s+ich\s+mich\s+(?:\S+\s+){0,6}bewerben)|i\s+am\s+writing\s+to\s+(?:apply|express\s+my\s+interest)/i;

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
    .map(({ path, text }): Issue => ({ level: "error", where: path, message: `unfinished placeholder: "${text.slice(0, 70)}"` }));
}

export function lintLetter(r: Resume, opts: { jd?: Jd } = {}): Issue[] {
  const l = r.letter;
  if (!l) return [];
  const out: Issue[] = [];
  const add = (level: Issue["level"], where: string, message: string) => out.push({ level, where, message });

  const placeholders = letterPlaceholders(r);
  if (placeholders.length)
    return [
      ...placeholders,
      { level: "info", where: "placeholders", message: `unfinished placeholders: ${placeholders.length} left — fill them in first; the other suggestions show up once none is left` },
    ];

  for (const { path, text } of [...(l.subject ? [{ path: "letter.subject", text: l.subject }] : []), ...l.body.map((text, i) => ({ path: `letter.body[${i}]`, text }))]) {
    const filler = [...new Set(text.match(FILLER_RE)?.map((w) => w.toLowerCase()))];
    if (filler.length) add("warn", path, `filler wording: ${filler.join(", ")} — say what you did and what changed`);
  }
  if (!l.subject) add("info", "letter.subject", 'no subject line — name the role (and the reference number), e.g. "Bewerbung als AI Engineer (m/w/d) – Ref. 4711"');

  const body = l.body.map(plainText).join("\n");

  const { reads, clear } = proseLanguage(body);
  if (reads && reads !== r.meta.lang)
    add(clear ? "error" : "warn", "meta.lang", `meta.lang is "${r.meta.lang}" but the letter reads as ${reads === "en" ? "English" : "German"} — the default salutation, closing and date follow meta.lang; translate the letter or set lang: ${reads}`);
  const words = body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words < LETTER_WORDS.min) add("info", "letter.body", `the letter has ${words} words — under ${LETTER_WORDS.min} reads as generic; add why this company and one or two concrete results`);
  else if (words > LETTER_WORDS.max) add("info", "letter.body", `the letter has ${words} words — over ${LETTER_WORDS.max} rarely gets read in full; keep the two strongest proofs`);

  l.body.forEach((p, i) => {
    const stock = plainText(p).match(STOCK_OPENER)?.[0];
    if (stock) add("info", `letter.body[${i}]`, `stock opener "${stock}" — open with something specific to this company or your strongest result instead`);
  });

  const company = r.target?.company ?? l.recipient?.[0];
  if (company && companyCore(company) && !companyCore(body).includes(companyCore(company)))
    add("warn", "letter.body", `the text never names ${company} — a letter that could go to any company reads as a mass mailing; say why this one`);

  if (opts.jd) {
    const ask = opts.jd.text;
    const salary = ask.match(ASKS_SALARY)?.[0];
    if (salary && !SAYS_SALARY.test(body))
      add("warn", "letter.body", `the JD asks for your salary expectation ("${salary}") and the letter names no figure — add one (e.g. "65.000 € brutto/Jahr"); ask yourself, don't guess`);
    const start = ask.match(ASKS_START)?.[0];
    if (start && !SAYS_START.test(body))
      add("warn", "letter.body", `the JD asks when you can start ("${start}") and the letter doesn't say — add your earliest start date or notice period`);
  }
  return out;
}

export async function runLetterCheck(r: Resume, pdf: Uint8Array, opts: { jd?: Jd; images?: Images; today?: string } = {}): Promise<CheckResult> {
  const l = letterParts(r, opts.today ?? localToday());
  const pages = await countPages(pdf);
  const pageTexts = await extractPages(pdf);
  const text = pageTexts.join("");
  const readingOrder = letterOrderProblem(r, text, l);
  const parser = [...identityProblems(r, text), ...missingLetterContent(r, text, l)];
  const where = r.letter?.signature ? "letter.signature" : "meta.signature.image";
  const issues = [...signatureIssue(letterSignaturePath(r), where, opts.images?.signature), ...lintLetter(r, { jd: opts.jd })];
  const over = pages > LETTER_PAGES;
  const all: Finding[] = [
    { level: over ? "error" : "ok", where: "pages", message: `${pages} / budget ${LETTER_PAGES}` },
    { level: readingOrder ? "error" : "ok", where: "reading order", message: readingOrder ?? "sender → recipient → date → subject → text → closing" },
    ...(parser.length ? parser : [{ level: "ok" as const, where: "parser view", message: "name first; contact details and every part of the letter in the text layer" }]),
    ...issues,
  ];
  const ok = !over && !readingOrder && ![...parser, ...issues].some((i) => i.level === "error");
  const landmarks: CheckResult["landmarks"] = [{ kind: "name", text: r.basics.name }];
  for (const key of ["email", "phone"] as const) if (r.basics[key]) landmarks.push({ kind: key, text: r.basics[key]! });
  return { ok, pages, budget: LETTER_PAGES, readingOrder, parser, lint: issues, text, pageTexts, landmarks, issues: all };
}
