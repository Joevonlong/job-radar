import type { CompiledLexicon } from "./compile-lexicon";
import type { CheckLimits } from "./limits";
import { parse, YAMLParseError } from "yaml";
import { z } from "zod";
import { CareerEngineError } from "./errors";
import { findHits, findTerms, type Hit, termSpans } from "./keywords";

export interface Jd {
  role: string;
  company: string;
  text: string;
}

export function parseJd(raw: string, limits: CheckLimits): Jd {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let frontmatter: unknown;
  try {
    frontmatter = fm ? parse(fm[1]) : {};
  } catch (error) {
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined;
    throw new CareerEngineError("career.jd.yaml_invalid", line === undefined ? {} : { line });
  }
  const meta = z.object({ role: z.unknown().optional(), company: z.unknown().optional() }).safeParse(frontmatter);
  const values = meta.success ? meta.data : {};
  const body = fm ? raw.slice(fm[0].length) : raw;
  const role =
    (typeof values.role === "string" && values.role) ||
    body.match(/^#\s+(.+)$/m)?.[1] ||
    body.split("\n").find((l) => l.trim()) ||
    "";

  return { role: role.trim().slice(0, limits.maxRole), company: typeof values.company === "string" ? values.company : "", text: body };
}

function titleWords(title: string, lexicon: CompiledLexicon): string[] {
  const t = title
    .replace(lexicon.level, " ")
    .toLowerCase()
    .replace(/(?<![\p{L}])(\p{L}+)-?(entwickler|ingenieur)(in(nen)?)?(?![\p{L}])/gu, (_m, pre) => `${pre} engineer`)
    .replace(/(?<![\p{L}])(entwickler|ingenieur)(in(nen)?)?(?![\p{L}])/gu, "engineer")
    .replace(/\bmachine[\s-]learning\b/g, "ml")
    .replace(/\b(full|back|front)[\s-]?(stack|end)\b/g, "$1$2")
    .replace(/\bki\b/g, "ai");
  return t
    .split(/[^\p{L}\p{N}+#.]+/u)
    .map((w) => (w === "developer" ? "engineer" : w.replace(/\.$/, "")))
    .filter((w) => w.length > 1 && !lexicon.titleStop.has(w));
}

const COMPANY_SEP = /\s+(?:[—–|@]|-|at)\s+(?=\S)/gi;
const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).map((w) => w.replace(/\.$/, "")).filter(Boolean);

export function jdRoleOnly(jdRole: string, lexicon: CompiledLexicon, companies: string[] = []): string {
  const named = new Set(companies.flatMap(wordsOf));
  let role = jdRole;
  for (;;) {
    const seps = [...role.matchAll(COMPANY_SEP)];
    const m = seps[seps.length - 1];
    if (!m) return role;
    const tail = role.slice(m.index + m[0].length);
    const sep = m[0].trim().toLowerCase();
    const isCompany =
      sep === "@" || sep === "at" || lexicon.legalWord.test(tail) || wordsOf(tail).some((w) => named.has(w)) ||
      (!named.size && !lexicon.roleWord.test(tail) && findTerms(tail, lexicon).size === 0);
    if (!isCompany) return role;
    role = role.slice(0, m.index);
  }
}

export function titleGap(resumeTitle: string, jdRole: string, lexicon: CompiledLexicon, companies: string[] = []): string[] {
  const have = new Set(titleWords(resumeTitle, lexicon));
  const skip = new Set(companies.flatMap(wordsOf));
  const legal = lexicon.legal;
  return [...new Set(titleWords(jdRoleOnly(jdRole, lexicon, companies), lexicon))].filter((w) => !have.has(w) && !skip.has(w) && !legal.test(w));
}

type Part = "required" | "nice" | "skip";

const ABBREV = /\b(e\.g|i\.e|z\.\s?B|u\.\s?a|d\.\s?h|bzw|ca|etc|inkl|mind|vs|incl|approx)\.$/i;

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const parts: string[] = [];
    for (const p of line.split(/(?<=[.!?;])\s+(?=[\p{Lu}\d*"„(])/u))
      if (parts.length && ABBREV.test(parts[parts.length - 1])) parts[parts.length - 1] += ` ${p}`;
      else parts.push(p);
    out.push(...parts);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const knownHeading = (line: string, lexicon: CompiledLexicon) =>
  line.length <= 40 &&
  [lexicon.requiredHead, lexicon.skipHead, lexicon.nice, lexicon.tasksHead].some((re) => {
    const m = line.match(re)?.[0];
    return m !== undefined && m.length >= 0.6 * line.replace(/[^\p{L} ]/gu, "").trim().length;
  });

const headingOf = (line: string, lexicon: CompiledLexicon) =>
  line.match(/^#{1,6}\s+(.+)$/)?.[1] ??
  line.match(/^\*\*([^*]{2,60})\*\*:?$/)?.[1] ??
  line.match(/^([^.!?:]{2,50}):$/)?.[1] ??
  (knownHeading(line, lexicon) ? line : undefined);

const partOfHeading = (h: string, lexicon: CompiledLexicon): Part => (lexicon.skipHead.test(h) ? "skip" : lexicon.nice.test(h) ? "nice" : "required");

export function segmentJd(text: string, lexicon: CompiledLexicon): Record<Part, string> {
  const parts: Record<Part, string[]> = { required: [], nice: [], skip: [] };
  let mode: Part = "required";
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s+/, "");
    if (!line) continue;
    const head = headingOf(line, lexicon);
    if (head !== undefined) {
      mode = partOfHeading(head, lexicon);
      continue;
    }
    for (let s of sentences(line)) {
      const label = s.match(/^\**([\p{L} '’/&-]{2,40}?)\**:\s*(.*)$/u);
      if (label && [lexicon.requiredHead, lexicon.skipHead, lexicon.nice, lexicon.tasksHead].some((re) => re.test(label[1]))) {
        mode = partOfHeading(label[1], lexicon);
        s = label[2];
      }
      const part: Part = mode === "skip" || lexicon.skipSentence.test(s) ? "skip" : mode === "nice" || lexicon.nice.test(s) ? "nice" : "required";
      parts[part].push(s);
    }
  }
  return { required: parts.required.join("\n"), nice: parts.nice.join("\n"), skip: parts.skip.join("\n") };
}

export interface TermMatch {
  term: string;
  jd: string;
  resume?: string;
  anyOf?: TermMatch[];
}
export interface Coverage {
  exact: TermMatch[];
  alias: TermMatch[];
  missing: TermMatch[];
}
export interface JdMatch {
  required: Coverage;
  nice: Coverage;
  unknown: { term: string; inResume: boolean }[];
}

const OR_SEP = /^\s*,?\s*(?:or|oder|bzw\.?|beziehungsweise|and\/or|und\/oder)\s+$/i;
const SLASH_SEP = /^\s*\/\s*$/;
const LIST_SEP = /^\s*,\s*$/;

export function orGroups(text: string, lexicon: CompiledLexicon): { groups: string[][]; alone: Set<string> } {
  const groups = new Map<string, string[]>();
  const alone = new Set<string>();
  const group = (terms: string[]) => {
    const uniq = [...new Set(terms)];
    if (uniq.length > 1) groups.set(uniq.join("\u0000"), uniq);
    else uniq.forEach((t) => alone.add(t));
  };
  for (const s of sentences(text)) {
    const spans = termSpans(s, lexicon);

    let run: { term: string; sep: string }[] = [];
    const close = () => {
      if (run.some((r) => OR_SEP.test(r.sep))) return group(run.map((r) => r.term));

      let part: string[] = [];
      for (const r of run) {
        if (!SLASH_SEP.test(r.sep)) {
          group(part);
          part = [];
        }
        part.push(r.term);
      }
      group(part);
    };
    spans.forEach((m, i) => {
      const sep = i ? s.slice(spans[i - 1].e, m.s) : "";
      if (i && !(m.s >= spans[i - 1].e && (OR_SEP.test(sep) || SLASH_SEP.test(sep) || LIST_SEP.test(sep)))) {
        close();
        run = [];
      }
      run.push({ term: m.term, sep: run.length ? sep : "" });
    });
    if (run.length) close();
  }
  return { groups: [...groups.values()], alone };
}

function cover(jd: Map<string, Hit>, have: Map<string, Hit>, alts: ReturnType<typeof orGroups>): Coverage {
  const c: Coverage = { exact: [], alias: [], missing: [] };
  const one = (term: string, hit: Hit) => {
    const m: TermMatch = { term, jd: hit.forms[0].text };
    const got = have.get(term);
    if (!got) return { m, as: "missing" as const };
    if (got.forms.some((f) => hit.forms.some((j) => j.key === f.key))) return { m, as: "exact" as const };
    return { m: { ...m, resume: got.forms[0].text }, as: "alias" as const };
  };

  const groups = alts.groups.map((g) => g.filter((t) => jd.has(t))).filter((g) => g.length > 1);
  const grouped = new Set(groups.flat().filter((t) => !alts.alone.has(t)));
  for (const [term, hit] of jd) {
    if (!grouped.has(term)) {
      const { m, as } = one(term, hit);
      c[as].push(m);
    }
    for (const g of groups.filter((g) => g[0] === term)) {
      const members = g.map((t) => one(t, jd.get(t)!));
      const m: TermMatch = { term: g.join(" / "), jd: members.map((x) => x.m.jd).join(" / "), anyOf: members.map((x) => x.m) };
      const alias = members.find((x) => x.as === "alias");
      if (members.some((x) => x.as === "exact")) c.exact.push(m);
      else if (alias) c.alias.push({ ...m, resume: alias.m.resume });
      else c.missing.push(m);
    }
  }
  return c;
}

export function jdMatch(jd: Jd, resumeText: string, lexicon: CompiledLexicon): JdMatch {
  const seg = segmentJd(jd.text, lexicon);
  const req = findHits(seg.required, lexicon, true);
  const nice = findHits(seg.nice, lexicon, true);
  for (const t of req.keys()) nice.delete(t);
  const have = findHits(resumeText, lexicon);
  return {
    required: cover(req, have, orGroups(seg.required, lexicon)),
    nice: cover(nice, have, orGroups(seg.nice, lexicon)),
    unknown: unknownTerms(`${seg.required}\n${seg.nice}`, lexicon, jd.company, resumeText),
  };
}

const QUANTITY = /^\d[\d.,]*(?:k|m|mio|h|x|min|s|ms|tb|gb|mb|%|€)?\+?$/i;
const ABBR_WORD = /^(e\.g|i\.e|z\.B|u\.a|d\.h|bzw|ca|etc|inkl|mind|incl)\.?$/i;

const techy = (w: string) =>
  /\p{Ll}\p{Lu}/u.test(w) ||
  /^\p{Lu}{2,}s?$/u.test(w) ||
  (/\p{L}/u.test(w) && /\d/.test(w) && !/^\d+(st|nd|rd|th|k|m|h|x|er|ern)?$/i.test(w)) ||
  /\p{L}[.+#]\p{L}|\p{L}[+#]+$|^\.\p{L}/u.test(w);

function unknownTerms(text: string, lexicon: CompiledLexicon, company: string, resumeText: string): { term: string; inResume: boolean }[] {
  const blank = new Uint8Array(text.length);
  for (const { aliases } of lexicon.dict) for (const a of aliases) for (const m of text.matchAll(a.re)) blank.fill(1, m.index, m.index + m[0].length);
  const rest = text.split("").map((c, i) => (blank[i] ? " " : c)).join("");
  const skip = new Set(company.toLowerCase().split(/\s+/));
  const seen = new Map<string, string>();
  for (const raw of rest.split(/[\s,;:()[\]{}"„“”'’!?/-]+/u)) {
    const w = raw.replace(/^\*+|[*.]+$/g, "");
    if (w.length < 2 || !/\p{L}/u.test(w) || QUANTITY.test(w) || lexicon.notTech.has(w) || ABBR_WORD.test(w) || skip.has(w.toLowerCase()) || /@|https?|www\.|\.(com|de|org|net|io|eu)$/i.test(w)) continue;
    if (techy(w) && !seen.has(w.toLowerCase())) seen.set(w.toLowerCase(), w);
  }
  const lower = resumeText.toLowerCase();
  return [...seen.values()].slice(0, 20).map((term) => ({ term, inResume: lower.includes(term.toLowerCase()) }));
}

const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
const CEFR_RE = /\b([ABC][12])\b\+?/g;

export function levelRank(s: string, lexicon: CompiledLexicon): { rank: number; cefr: boolean; native: boolean } | undefined {
  const native = lexicon.native.test(s);
  if (native) return { rank: 6, cefr: false, native };
  const codes = [...s.matchAll(CEFR_RE)].map((m) => CEFR.indexOf(m[1]) + 1);
  if (codes.length) return { rank: Math.max(...codes), cefr: true, native };
  for (const { re, rank } of lexicon.levelWords) if (re.test(s)) return { rank, cefr: false, native };
  return undefined;
}
export const levelName = (rank: number) => CEFR[rank - 1];

export interface LangReq {
  lang: string;
  rank?: number;
  nice: boolean;
  quote: string;
}

export function languageRequirements(text: string, lexicon: CompiledLexicon): LangReq[] {
  const seg = segmentJd(text, lexicon);
  const out = new Map<string, LangReq>();
  for (const [nice, part] of [[false, seg.required], [true, seg.nice]] as const)
    for (const s of sentences(part)) {
      const langs = Object.entries(lexicon.langs)
        .flatMap(([lang, re]) => [...s.matchAll(re)].map((m) => ({ lang, at: m.index, end: m.index + m[0].length })))
        .sort((a, b) => a.at - b.at);
      if (!langs.length) continue;
      const found = [
        ...[...s.matchAll(CEFR_RE)].map((m) => ({ at: m.index, end: m.index + m[0].length, rank: CEFR.indexOf(m[1]) + 1 })),
        ...lexicon.levelWords.flatMap(({ re, rank }) => [...s.matchAll(new RegExp(re.source, "giu"))].map((m) => ({ at: m.index, end: m.index + m[0].length, rank }))),
      ];

      const levels = found.filter((v) => !found.some((o) => o !== v && o.at <= v.at && o.end >= v.end && o.end - o.at > v.end - v.at)).sort((a, b) => a.at - b.at);

      const about = (l: (typeof langs)[number]) =>
        levels.length > 0 ||
        lexicon.langContext.test(s.slice(Math.max(0, l.at - 25), l.end + 25)) ||
        (/^[\W\d]*$/.test(s.slice(0, l.at)) && /^\s+(is|would be|are)\b/i.test(s.slice(l.end)));
      if (!langs.some(about)) continue;

      const claimed = new Set<number>();
      langs.forEach((l, i) => {
        const next = langs[i + 1]?.at ?? s.length;
        const prev = i ? langs[i - 1].end : 0;
        const after = levels.find((v) => v.at >= l.end && v.at < next);
        const before = [...levels].reverse().find((v) => v.at < l.at && v.at >= prev && !claimed.has(v.at));
        const only = new Set(levels.map((v) => v.rank)).size === 1 ? levels[0] : undefined;
        const lv = after ?? before ?? only;
        if (lv) claimed.add(lv.at);
        const req: LangReq = { lang: l.lang, rank: lv?.rank, nice, quote: s.length > 90 ? `${s.slice(0, 87)}…` : s };
        const old = out.get(l.lang);
        if (!old || (old.nice && !nice) || (old.nice === nice && (req.rank ?? 0) > (old.rank ?? 0))) out.set(l.lang, req);
      });
    }
  return [...out.values()];
}

export const resumeLanguage = (langs: { name: string; level: string }[], lang: string, lexicon: CompiledLexicon) => langs.find((l) => lexicon.names[lang]?.test(l.name.trim()));

export function degreeRequirement(text: string, lexicon: CompiledLexicon): { quote: string; nice: boolean } | undefined {
  const seg = segmentJd(text, lexicon);
  for (const [nice, part] of [[false, seg.required], [true, seg.nice]] as const)
    for (const s of sentences(part)) if (lexicon.degree.test(s)) return { quote: s.length > 90 ? `${s.slice(0, 87)}…` : s, nice };
  return undefined;
}
