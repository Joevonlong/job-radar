import { countPages, extractPages, missingContent, parserProblems, readingOrderProblem } from "./extract";
import { type Coverage, degreeRequirement, type Jd, jdMatch, type LangReq, languageRequirements, levelName, levelRank, resumeLanguage, type TermMatch, titleGap } from "./jd";
import { DICT, type Dict, findHits } from "./keywords";
import { type Issue, lint, proseLanguage } from "./lint";
import { imageType, type Images } from "./images";
import type { Resume } from "./schema";
import { hasContent, headingOf, isCustom, plainText, resolveSections } from "./sections";

export type Finding = Omit<Issue, "level"> & { level: Issue["level"] | "ok" };

const MAX_MENTIONS = 4;

const GOOD_COVERAGE = 70;

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
  readingOrder: string | null;
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

function languageFindings(r: Resume, jd: Jd): JdReport["languages"] {
  return languageRequirements(jd.text).map((req) => {
    const want = req.rank ? ` ${levelName(req.rank)}` : "";
    const where = "languages";
    const have = resumeLanguage(r.languages, req.lang);
    if (!have)
      return { ...req, level: req.nice ? "info" : "warn", where, message: `${req.lang}${want}: the JD asks for it ("${req.quote}") — add it to languages with a CEFR level if you speak it` };
    const lv = levelRank(have.level);
    if (req.rank && lv && lv.rank < req.rank)
      return { ...req, level: req.nice ? "info" : "warn", where, message: `${req.lang}: the JD asks for${want} ("${req.quote}"), you list "${have.level}" — a likely screen-out; state your real level, don't round up` };
    if (lv?.native) return { ...req, level: "ok", where, message: `${req.lang}: "${have.level}" — a native speaker meets ${want ? `the JD's${want}` : "any level"}` };
    if (!lv?.cefr) return { ...req, level: "info", where, message: `${req.lang}: you list "${have.level}" — add the CEFR level (e.g. C1); screeners filter on it` };
    return { ...req, level: "ok", where, message: `${req.lang}: "${have.level}" ${want ? `meets the JD's${want}` : "listed (the JD names no level)"}` };
  });
}

function educationFinding(r: Resume, jd: Jd): Finding | undefined {
  const req = degreeRequirement(jd.text);
  if (!req) return undefined;
  const shown = resolveSections(r).some((s) => s.kind === "builtin" && s.name === "education") ? r.education : [];
  if (!shown.length)
    return { level: req.nice ? "info" : "warn", where: "education", message: `the JD asks for a degree or training ("${req.quote}") — your resume shows no education; add it if you have it` };
  return { level: "ok", where: "education", message: `the JD asks for "${req.quote}" — your education: ${shown.map((e) => `${e.degree}, ${e.school}`).join("; ")}` };
}

const LANG_NAME = { en: "English", de: "German" } as const;

function langFinding(r: Resume, jd: Jd): Finding | undefined {
  const reads = proseLanguage(jd.text).reads;
  if (!reads || reads === r.meta.lang) return undefined;
  return {
    level: "info",
    where: "meta.lang",
    message: `the JD is in ${LANG_NAME[reads]}, your resume in ${LANG_NAME[r.meta.lang]} — ${reads === "de" ? "German postings usually expect a German resume" : "answer an English posting in English"} unless the posting says otherwise; translate faithfully (meta.lang: ${reads})`,
  };
}

function jdReport(r: Resume, text: string, jd: Jd, dict: Dict): JdReport {
  const m = jdMatch(jd, text, dict);
  const asked = new Set(
    [...m.required.exact, ...m.required.alias, ...m.required.missing, ...m.nice.exact, ...m.nice.alias, ...m.nice.missing].flatMap((t) => (t.anyOf ?? [t]).map((a) => a.term)),
  );
  const stuffing: Finding[] = [...findHits(prose(r), dict)]
    .filter(([term, hit]) => asked.has(term) && hit.count > MAX_MENTIONS)
    .map(([term, hit]) => ({ level: "warn", where: "keywords", message: `"${term}" appears ${hit.count} times in your sentences — more than ${MAX_MENTIONS} reads as keyword stuffing; keep the strongest mentions` }));
  return {
    role: jd.role,
    company: jd.company,
    titleGap: titleGap(r.basics.title, jd.role, [jd.company, r.target?.company ?? ""]),
    required: { ...m.required, pct: pct(m.required) },
    nice: { ...m.nice, pct: pct(m.nice) },
    unknown: m.unknown,
    languages: languageFindings(r, jd),
    stuffing,
    education: educationFinding(r, jd),
    lang: langFinding(r, jd),
  };
}

const label = (t: TermMatch) => (t.anyOf ? `${t.jd} (any one)` : t.jd);

export function jdFindings(j: JdReport, title: string): Finding[] {
  const out: Finding[] = [];
  out.push(
    j.titleGap.length
      ? { level: "warn", where: "basics.title", message: `JD asks for "${j.role}", resume says "${title}" — missing: ${j.titleGap.join(", ")}; align the headline if it's true` }
      : { level: "ok", where: "basics.title", message: `matches "${j.role}"` },
  );
  const { required: q, nice: n } = j;
  const total = q.exact.length + q.alias.length + q.missing.length;
  out.push({ level: q.pct >= GOOD_COVERAGE ? "ok" : "warn", where: "jd.required", message: `${q.exact.length}/${total} required JD terms in the JD's own spelling (${q.pct}%)` });
  for (const a of q.alias) out.push({ level: "warn", where: "jd.required", message: `~ ${label(a)} (resume says "${a.resume}"; use the JD spelling where it's true)` });
  if (q.missing.length) out.push({ level: "warn", where: "jd.required", message: `missing: ${q.missing.map(label).join(", ")} — add only what you can back up` });
  const nTotal = n.exact.length + n.alias.length + n.missing.length;
  if (nTotal) {
    out.push({ level: "info", where: "jd.nice", message: `${n.exact.length}/${nTotal} nice-to-have terms in the JD's spelling (${n.pct}%)` });
    for (const a of n.alias) out.push({ level: "info", where: "jd.nice", message: `~ ${label(a)} (resume says "${a.resume}")` });
    if (n.missing.length) out.push({ level: "info", where: "jd.nice", message: `missing: ${n.missing.map(label).join(", ")}` });
  }
  if (j.unknown.length)
    out.push({ level: "info", where: "jd.unknown", message: `not in the dictionary, judge yourself: ${j.unknown.map((u) => (u.inResume ? `${u.term} (in resume)` : u.term)).join(", ")}` });
  if (j.lang) out.push(j.lang);
  for (const l of j.languages) out.push({ level: l.level, where: l.where, message: l.message });
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
  return [{ level: "error", where: "basics.photo", message: `photo "${r.basics.photo}" doesn't exist, can't be read or isn't a PNG / JPEG / WebP image (the path is relative to the YAML file) — the PDF has no photo; fix the path or remove basics.photo` }];
}

export function signatureIssue(path: string | undefined, where: string, bytes: Uint8Array | undefined): Issue[] {
  if (!path || (bytes && imageType(bytes))) return [];
  return [{ level: "error", where, message: `signature image "${path}" doesn't exist, can't be read or isn't a PNG / JPEG / WebP image (the path is relative to the YAML file) — the PDF has no signature; fix the path or remove it` }];
}

export async function runCheck(r: Resume, pdf: Uint8Array, opts: { jd?: Jd; dict?: Dict; images?: Images } = {}): Promise<CheckResult> {
  const dict = opts.dict ?? DICT;
  const pages = await countPages(pdf);
  const pageTexts = await extractPages(pdf);
  const text = pageTexts.join("");
  const readingOrder = readingOrderProblem(r, text);
  const parser = [...parserProblems(r, text), ...missingContent(r, text)];
  const issues = [...photoIssues(r, opts.images?.photo), ...signatureIssue(r.meta.signature?.image, "meta.signature.image", opts.images?.signature), ...lint(r, dict)];
  const jd = opts.jd && jdReport(r, text, opts.jd, dict);
  const over = pages > r.meta.pages;
  const all: Finding[] = [
    { level: over ? "error" : "ok", where: "pages", message: `${pages} / budget ${r.meta.pages}` },
    { level: readingOrder ? "error" : "ok", where: "reading order", message: readingOrder ?? "headings and bullets intact" },
    ...(parser.length ? parser : [{ level: "ok" as const, where: "parser view", message: "name first; contact details, headings and every shown field in the text layer" }]),
    ...issues,
    ...(jd ? jdFindings(jd, r.basics.title) : []),
  ];
  const ok = !over && !readingOrder && ![...parser, ...issues].some((i) => i.level === "error");
  return { ok, pages, budget: r.meta.pages, readingOrder, parser, lint: issues, jd, text, pageTexts, landmarks: landmarks(r), issues: all };
}
