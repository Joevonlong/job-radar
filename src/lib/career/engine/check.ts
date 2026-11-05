import { compileLexicon, type CompiledLexicon } from "./compile-lexicon";
import type { CheckLexicon } from "./lexicon";
import type { CheckLimits } from "./limits";
import type { Diagnostic, Finding, Issue } from "./finding";
import { countPages, extractPages, missingContent, parserProblems, readingOrderProblem } from "./extract";
import { type Coverage, degreeRequirement, type Jd, jdMatch, type LangReq, languageRequirements, levelName, levelRank, resumeLanguage, type TermMatch, titleGap } from "./jd";
import { findHits } from "./keywords";
import { lint, proseLanguage } from "./lint";
import { imageType, type Images } from "./images";
import type { Resume } from "./schema";
import { hasContent, headingOf, isCustom, plainText, resolveSections } from "./sections";

export type { Finding } from "./finding";

export interface JdReport {
  role: string;
  company: string;
  titleGap: string[];
  required: Coverage & { pct: number };
  nice: Coverage & { pct: number };
  unknown: { term: string; inResume: boolean }[];
  languages: (LangReq & Finding)[];
  stuffing: Finding[];
  education?: Finding;
  lang?: Finding;
}

export interface CheckResult {
  ok: boolean;
  pages: number;
  budget: number;
  readingOrder: Diagnostic | null;
  parser: Issue[];
  lint: Issue[];
  jd?: JdReport;
  text: string;
  pageTexts: string[];
  landmarks: { kind: "name" | "email" | "phone" | "heading"; text: string }[];
  issues: Finding[];
}

const pct = (c: Coverage) => {
  const all = c.exact.length + c.alias.length + c.missing.length;
  return all ? Math.round((100 * c.exact.length) / all) : 100;
};

function prose(r: Resume): string {
  const custom = (r.sections ?? []).flatMap((s) =>
    !isCustom(s) ? [] : s.items.flatMap((it) => (it.kind === "entry" ? [it.text ?? "", ...it.bullets] : it.kind === "bullet" || it.kind === "text" ? [it.text] : [])),
  );
  return [
    r.basics.summary ?? "",
    ...r.approach.map((a) => a.text),
    ...r.experience.flatMap((e) => [e.summary ?? "", ...e.bullets]),
    ...r.projects.flatMap((p) => p.bullets),
    ...custom,
  ]
    .map(plainText)
    .join("\n");
}

function languageFindings(r: Resume, jd: Jd, lexicon: CompiledLexicon): JdReport["languages"] {
  return languageRequirements(jd.text, lexicon).map((req): LangReq & Finding => {
    const want = req.rank ? levelName(req.rank) : "";
    const where = "languages";
    const have = resumeLanguage(r.languages, req.lang, lexicon);
    if (!have)
      return { ...req, level: req.nice ? "info" : "warn", where, code: "career.check.language_missing", params: { lang: req.lang, ...(want ? { level: want } : {}), quote: req.quote } };
    const lv = levelRank(have.level, lexicon);
    if (req.rank && lv && lv.rank < req.rank)
      return { ...req, level: req.nice ? "info" : "warn", where, code: "career.check.language_low", params: { lang: req.lang, level: want, quote: req.quote, have: have.level } };
    if (lv?.native) return { ...req, level: "ok", where, code: "career.check.language_native", params: { lang: req.lang, have: have.level, ...(want ? { level: want } : {}) } };
    if (!lv?.cefr) return { ...req, level: "info", where, code: "career.check.language_cefr_missing", params: { lang: req.lang, have: have.level } };
    return { ...req, level: "ok", where, code: "career.check.language_met", params: { lang: req.lang, have: have.level, ...(want ? { level: want } : {}) } };
  });
}

function educationFinding(r: Resume, jd: Jd, lexicon: CompiledLexicon): Finding | undefined {
  const req = degreeRequirement(jd.text, lexicon);
  if (!req) return undefined;
  const shown = resolveSections(r).some((s) => s.kind === "builtin" && s.name === "education") ? r.education : [];
  if (!shown.length)
    return { level: req.nice ? "info" : "warn", where: "education", code: "career.check.education_missing", params: { quote: req.quote } };
  return { level: "ok", where: "education", code: "career.check.education_listed", params: { quote: req.quote, education: shown.map((e) => `${e.degree}, ${e.school}`).join("; ") } };
}

function langFinding(r: Resume, jd: Jd, limits: CheckLimits, lexicon: CompiledLexicon): Finding | undefined {
  const reads = proseLanguage(jd.text, limits, lexicon).reads;
  if (!reads || reads === r.meta.lang) return undefined;
  return {
    level: "info",
    where: "meta.lang",
    code: "career.check.language_mismatch", params: { reads, lang: r.meta.lang },
  };
}

function jdReport(r: Resume, text: string, jd: Jd, limits: CheckLimits, lexicon: CompiledLexicon): JdReport {
  const m = jdMatch(jd, text, lexicon);
  const asked = new Set(
    [...m.required.exact, ...m.required.alias, ...m.required.missing, ...m.nice.exact, ...m.nice.alias, ...m.nice.missing].flatMap((t) => (t.anyOf ?? [t]).map((a) => a.term)),
  );
  const stuffing: Finding[] = [...findHits(prose(r), lexicon)]
    .filter(([term, hit]) => asked.has(term) && hit.count > limits.maxMentions)
    .map(([term, hit]) => ({ level: "warn", where: "keywords", code: "career.check.stuffing", params: { term, count: hit.count, max: limits.maxMentions } }));
  return {
    role: jd.role,
    company: jd.company,
    titleGap: titleGap(r.basics.title, jd.role, lexicon, [jd.company, r.target?.company ?? ""]),
    required: { ...m.required, pct: pct(m.required) },
    nice: { ...m.nice, pct: pct(m.nice) },
    unknown: m.unknown,
    languages: languageFindings(r, jd, lexicon),
    stuffing,
    education: educationFinding(r, jd, lexicon),
    lang: langFinding(r, jd, limits, lexicon),
  };
}

function termParams(terms: TermMatch[]): Record<string, string> {
  const anyOf = terms.filter((t) => t.anyOf).map((t) => t.jd).join(", ");
  return { terms: terms.map((t) => t.jd).join(", "), ...(anyOf ? { anyOf } : {}) };
}

export function jdFindings(j: JdReport, title: string, limits: CheckLimits): Finding[] {
  const out: Finding[] = [];
  out.push(
    j.titleGap.length
      ? { level: "warn", where: "basics.title", code: "career.check.title_gap", params: { role: j.role, title, terms: j.titleGap.join(", ") } }
      : { level: "ok", where: "basics.title", code: "career.check.title_matches", params: { role: j.role } },
  );
  const { required: q, nice: n } = j;
  const total = q.exact.length + q.alias.length + q.missing.length;
  out.push({ level: q.pct >= limits.goodCoverage ? "ok" : "warn", where: "jd.required", code: "career.check.required_coverage", params: { count: q.exact.length, total, pct: q.pct } });
  for (const a of q.alias) out.push({ level: "warn", where: "jd.required", code: "career.check.required_alias", params: { ...termParams([a]), resume: a.resume! } });
  if (q.missing.length) out.push({ level: "warn", where: "jd.required", code: "career.check.required_missing", params: termParams(q.missing) });
  const nTotal = n.exact.length + n.alias.length + n.missing.length;
  if (nTotal) {
    out.push({ level: "info", where: "jd.nice", code: "career.check.nice_coverage", params: { count: n.exact.length, total: nTotal, pct: n.pct } });
    for (const a of n.alias) out.push({ level: "info", where: "jd.nice", code: "career.check.nice_alias", params: { ...termParams([a]), resume: a.resume! } });
    if (n.missing.length) out.push({ level: "info", where: "jd.nice", code: "career.check.nice_missing", params: termParams(n.missing) });
  }
  if (j.unknown.length)
    out.push({ level: "info", where: "jd.unknown", code: "career.check.unknown_terms", params: { terms: j.unknown.map((u) => u.term).join(", "), ...(j.unknown.some((u) => u.inResume) ? { inResume: j.unknown.filter((u) => u.inResume).map((u) => u.term).join(", ") } : {}) } });
  if (j.lang) out.push(j.lang);
  for (const l of j.languages) out.push({ level: l.level, where: l.where, code: l.code, ...(l.params ? { params: l.params } : {}) });
  if (j.education) out.push(j.education);
  out.push(...j.stuffing);
  return out;
}

function landmarks(r: Resume): CheckResult["landmarks"] {
  const out: CheckResult["landmarks"] = [{ kind: "name", text: r.basics.name }];
  for (const key of ["email", "phone"] as const) if (r.basics[key]) out.push({ kind: key, text: r.basics[key]! });
  for (const s of resolveSections(r)) {
    const title = s.kind === "custom" ? s.title : s.name !== "summary" && hasContent(r, s.name) ? headingOf(r, s.name) : undefined;
    if (title) out.push({ kind: "heading", text: title });
  }
  return out;
}

function photoIssues(r: Resume, bytes: Uint8Array | undefined): Issue[] {
  if (!r.basics.photo || (bytes && imageType(bytes))) return [];
  return [{ level: "error", where: "basics.photo", code: "career.check.photo_unreadable", params: { path: r.basics.photo } }];
}

export function signatureIssue(path: string | undefined, where: string, bytes: Uint8Array | undefined): Issue[] {
  if (!path || (bytes && imageType(bytes))) return [];
  return [{ level: "error", where, code: "career.check.signature_unreadable", params: { path } }];
}

export async function runCheck(r: Resume, pdf: Uint8Array, opts: { today: string; limits: CheckLimits; lexicon: CheckLexicon; jd?: Jd; images?: Images }): Promise<CheckResult> {
  const lexicon = compileLexicon(opts.lexicon);
  const { limits, today } = opts;
  const pages = await countPages(pdf);
  const pageTexts = await extractPages(pdf);
  const text = pageTexts.join("");
  const readingOrder = readingOrderProblem(r, text);
  const parser = [...parserProblems(r, text), ...missingContent(r, text, today, limits)];
  const issues = [...photoIssues(r, opts.images?.photo), ...signatureIssue(r.meta.signature?.image, "meta.signature.image", opts.images?.signature), ...lint(r, opts)];
  const jd = opts.jd && jdReport(r, text, opts.jd, limits, lexicon);
  const over = pages > r.meta.pages;
  const all: Finding[] = [
    { level: over ? "error" : "ok", where: "pages", code: "career.check.pages", params: { pages, budget: r.meta.pages } },
    { level: readingOrder ? "error" : "ok", where: "reading_order", ...(readingOrder ?? { code: "career.check.order_ok" }) },
    ...(parser.length ? parser : [{ level: "ok" as const, where: "parser_view", code: "career.check.parser_ok" }]),
    ...issues,
    ...(jd ? jdFindings(jd, r.basics.title, limits) : []),
  ];
  const ok = !over && !readingOrder && ![...parser, ...issues].some((i) => i.level === "error");
  return { ok, pages, budget: r.meta.pages, readingOrder, parser, lint: issues, jd, text, pageTexts, landmarks: landmarks(r), issues: all };
}
