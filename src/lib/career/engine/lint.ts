import { compileLexicon, type CompiledLexicon } from "./compile-lexicon";
import type { CheckLexicon } from "./lexicon";
import type { CheckLimits } from "./limits";
import type { Diagnostic, Issue } from "./finding";
import { i18n } from "./i18n";
import { findTerms } from "./keywords";
import type { Resume } from "./schema";
import { BUILTINS, builtinOf, hasContent, isCustom, plainText } from "./sections";

export type { Issue } from "./finding";

export const PLACEHOLDER = /⟨[^⟩]*⟩|\bTODO\b|\bTBD\b|\bxxx\b/i;

const PRONOUN = /^(I|we|my|ich|wir)(?![\p{L}\p{N}'’])/iu;
const IRREGULAR = "built|made|done|given|taken|written|chosen|run|shown|led|sent|seen|held|brought|kept|won|found|grown|drawn|set|put|cut|begun|known|paid|sold|taught|thought|bought";
const PASSIVE_EN = new RegExp(`\\b(was|were|been)\\s+(?:\\w+ly\\s+)?(\\w+ed|(?:re)?(?:${IRREGULAR}))\\b`, "i");

const PASSIVE_DE = /\b(wurden?)\b[^,.;:]*?(?<![\p{L}])(\p{Ll}*ge\p{Ll}{2,}(?:t|en)|\p{Ll}{3,}iert|(?:be|ent|er|ver|zer)\p{Ll}{3,}t)(?![\p{L}])/u;

export function proseLanguage(text: string, limits: CheckLimits, lexicon: CompiledLexicon): { reads?: "en" | "de"; clear: boolean } {
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  const en = words.filter((w) => lexicon.proseWords.en.has(w)).length;
  const de = words.filter((w) => lexicon.proseWords.de.has(w)).length;
  const reads = en + de >= limits.proseMinWords && en >= limits.proseRatio * de ? "en" : en + de >= limits.proseMinWords && de >= limits.proseRatio * en ? "de" : undefined;
  return { reads, clear: en + de >= limits.proseClearWords && (en >= limits.proseClearRatio * de || de >= limits.proseClearRatio * en) };
}

function strings(value: unknown, path = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

const months = (d: string, edge: "start" | "end", today: string) => {
  if (d === "present") {
    const [year, month] = today.split("-").map(Number);
    return year * 12 + month - 1;
  }
  const [y, m] = d.split("-").map(Number);
  return y * 12 + (m ? m - 1 : edge === "start" ? 0 : 11);
};

const YEARS = /(?<![\p{L}\p{N}])(?:(over|more than|about|almost|nearly|über|mehr als|fast|knapp|rund|ca\.?)\s+)?(\d{1,2})\s*(\+?)\s*(?:years?|yrs?|jahren?)(?![\p{L}])/giu;

const WHOLE_CAREER = new RegExp(
  "^\\s*(?:" +
    [
      "(?:of\\s+)?(?:professional\\s+|industry\\s+|work\\s+|hands-on\\s+|relevant\\s+)?experience(?:\\s+(?:in|as)\\s+(?:software|it|tech|the\\s+industry|industry|(?:software\\s+)?engineering|software\\s+development))?",
      "in\\s+(?:software|it|tech|the\\s+industry|industry|(?:software\\s+)?engineering|software\\s+development)",
      "(?:berufs)?erfahrung(?:\\s+in\\s+der\\s+(?:softwareentwicklung|it|software\\p{L}*))?",
      "in\\s+der\\s+(?:softwareentwicklung|it|software\\p{L}*)",
    ].join("|") +
    ")?\\s*(?:$|[.,;:!)—–-]|\\s(?:and|und)\\s)",
  "iu",
);

function experienceMonths(r: Resume, today: string): number | undefined {
  if (!r.experience.length || r.experience.some((e) => !e.end || e.start.startsWith("0000") || e.end.startsWith("0000"))) return undefined;
  const spans = r.experience.map((e) => [months(e.start, "start", today), months(e.end!, "end", today)] as const).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let upTo = -Infinity;
  for (const [s, e] of spans) {
    const from = Math.max(s, upTo + 1);
    if (e >= from) total += e - from + 1;
    upTo = Math.max(upTo, e);
  }
  return total;
}

const squash = (s: string) => plainText(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export function placeholderIssues(r: Resume): Issue[] {
  const out: Issue[] = [];
  for (const { path, text } of strings({ ...r, letter: undefined })) {
    if (PLACEHOLDER.test(text)) out.push({ level: "error", where: path, code: "career.lint.placeholder", params: { text: text.slice(0, 70) } });
    else if (/\.(start|end|date)$/.test(path) && /^0000\b/.test(text)) out.push({ level: "error", where: path, code: "career.lint.placeholder_date", params: { date: text } });
  }
  return out;
}

export function lint(r: Resume, opts: { today: string; limits: CheckLimits; lexicon: CheckLexicon }): Issue[] {
  const { today, limits } = opts;
  const lexicon = compileLexicon(opts.lexicon);
  const issues: Issue[] = [];
  const add = (level: Issue["level"], where: string, code: string, params?: Diagnostic["params"]) => issues.push({ level, where, code, ...(params ? { params } : {}) });

  const placeholders = placeholderIssues(r);

  for (const { path, text } of strings({ ...r, letter: undefined })) {
    const filler = [...new Set(text.match(lexicon.filler)?.map((w) => w.toLowerCase()))];
    if (filler.length) add("warn", path, "career.lint.filler", { terms: filler.join(", ") });
  }

  if (placeholders.length)
    return [
      ...placeholders,
      { level: "info", where: "placeholders", code: "career.lint.placeholders", params: { count: placeholders.length } },
    ];

  const entries = [
    ...r.experience.map((e, i) => ({ where: `experience[${i}]`, name: e.company, bullets: e.bullets })),
    ...r.projects.map((p, i) => ({ where: `projects[${i}]`, name: p.name, bullets: p.bullets })),
  ];
  const custom: typeof entries = [];
  r.sections?.forEach((s, i) => {
    if (!isCustom(s)) return;
    s.items.forEach((it, j) => {
      if (it.kind === "entry") custom.push({ where: `sections[${i}].items[${j}]`, name: it.heading, bullets: it.bullets });
    });
  });

  const longBullet = (where: string, b: string) => {
    const n = plainText(b).length;
    if (n > limits.maxBullet) add("warn", where, "career.lint.bullet_long", { count: n, max: limits.maxBullet, text: `${plainText(b).slice(0, 50)}…` });
  };
  const tooMany = (where: string, n: number) => {
    if (n > limits.maxBulletsPerEntry) add("info", where, "career.lint.bullets_many", { count: n, max: limits.maxBulletsPerEntry });
  };

  const seen = new Map<string, string>();
  for (const { where, bullets } of [...entries, ...custom]) {
    const openers = new Map<string, number>();
    bullets.forEach((b, k) => {
      const at = `${where}.bullets[${k}]`;
      const text = plainText(b).trim();
      longBullet(at, b);
      if (text.length < limits.minBullet) add("info", at, "career.lint.bullet_short", { count: text.length, text });
      const pronoun = text.match(PRONOUN)?.[0];
      if (pronoun) add("warn", at, "career.lint.pronoun", { pronoun });
      const weak = text.match(lexicon.weak)?.[1];
      if (weak) add("warn", at, "career.lint.weak_opener", { text: weak });
      const passive = text.match(PASSIVE_EN)?.[0] ?? text.match(PASSIVE_DE)?.[0];
      if (passive) add("info", at, "career.lint.passive", { text: passive });
      const key = squash(b);
      if (key && seen.has(key)) add("warn", at, "career.lint.duplicate_bullet", { where: seen.get(key)! });
      else if (key) seen.set(key, at);
      const verb = text.replace(PRONOUN, "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}-]/gu, "");
      if (verb) openers.set(verb, (openers.get(verb) ?? 0) + 1);
    });
    for (const [verb, n] of openers)
      if (n > 2) add("info", where, "career.lint.repeated_opener", { count: n, verb });
    tooMany(where, bullets.length);
  }

  r.sections?.forEach((s, i) => {
    if (!isCustom(s)) return;
    s.items.forEach((it, j) => {
      if (it.kind === "bullet" || it.kind === "check") longBullet(`sections[${i}].items[${j}]`, it.text);
    });
  });

  const all = entries.flatMap((e) => e.bullets);
  const quantified = all.filter((b) => /\d/.test(b)).length;
  if (all.length && quantified / all.length < 0.5)
    add("info", "bullets", "career.lint.unquantified", { count: quantified, total: all.length });
  const latest = r.experience.reduce((best, e, i) => (months(e.start, "start", today) > months(r.experience[best].start, "start", today) ? i : best), 0);
  const recent = r.experience[latest];
  if (recent?.bullets.length && !recent.bullets.some((b) => /\d/.test(b)))
    add("warn", `experience[${latest}]`, "career.lint.recent_unquantified", { company: recent.company });

  r.experience.forEach((e, i) => {
    if (e.end === undefined) add("warn", `experience[${i}]`, "career.lint.end_missing", { company: e.company });
    const next = r.experience[i + 1];
    if (next && months(next.start, "start", today) > months(e.start, "start", today))
      add("warn", `experience[${i + 1}]`, "career.lint.experience_order", { next: next.company, company: e.company });
  });

  const byStart = r.experience.every((e) => e.end) ? [...r.experience].sort((a, b) => months(a.start, "start", today) - months(b.start, "start", today)) : [];
  let covered: { end: number; company: string } | undefined;
  for (const e of byStart) {
    const gap = covered ? months(e.start, "start", today) - covered.end - 1 : 0;
    if (covered && gap > limits.maxGapMonths)
      add("info", "experience", "career.lint.experience_gap", { months: gap, before: covered.company, after: e.company });
    const end = months(e.end!, "end", today);
    if (!covered || end > covered.end) covered = { end, company: e.company };
  }

  const total = experienceMonths(r, today);
  if (total !== undefined) {
    const years = Math.round((total / 12) * 10) / 10;
    const claims = [{ where: "basics.summary", text: r.basics.summary ?? "" }, ...r.approach.map((a, i) => ({ where: `approach[${i}].text`, text: a.text }))];
    for (const { where, text } of claims)
      for (const m of plainText(text).matchAll(YEARS)) {
        const n = Number(m[2]);
        const atLeast = !!(m[3] || /^(over|more than|über|mehr als)$/i.test(m[1] ?? ""));
        const whole = WHOLE_CAREER.test(plainText(text).slice(m.index + m[0].length, m.index + m[0].length + 60));
        if (n >= years + 1)
          add("warn", where, "career.lint.years_overstated", { text: m[0].trim(), years });
        else if (whole && !atLeast && years >= n + 1)
          add("warn", where, "career.lint.years_stale", { text: m[0].trim(), years });
      }
  }

  const headings = new Set(
    [...Object.entries(i18n("en").t), ...Object.entries(i18n("de").t)]
      .filter(([k]) => k !== "present")
      .map(([, v]) => v.toLowerCase())
      .concat((r.sections ?? []).flatMap((s) => (typeof s === "string" ? [] : [s.title.trim().toLowerCase()]))),
  );
  r.skills.forEach((g, i) => {
    if (!headings.has(g.group.trim().toLowerCase())) return;
    const lang = /^(languages|sprachen)$/i.test(g.group.trim());
    add("info", `skills[${i}].group`, "career.lint.skill_heading", { group: g.group, ...(lang ? { hint: "languages" } : {}) });
  });

  const body = [
    ...r.experience.flatMap((e) => [e.role, e.summary ?? "", ...e.bullets, ...e.stack]),
    ...r.projects.flatMap((p) => [p.name, p.tagline ?? "", ...p.bullets, ...p.stack]),
  ].map(plainText).join("\n");
  const bodyTerms = findTerms(body, lexicon);
  const lowerBody = body.toLowerCase();
  r.skills.forEach((g, i) =>
    g.items.forEach((item, j) => {
      const terms = findTerms(item, lexicon);
      const shown = terms.size ? [...terms].some((t) => bodyTerms.has(t)) : lowerBody.includes(item.replace(/\s*\(.*?\)\s*/g, "").trim().toLowerCase());
      if (!shown) add("info", `skills[${i}].items[${j}]`, "career.lint.skill_unproven", { term: item });
    }),
  );

  const prose = [r.basics.summary ?? "", ...r.approach.map((a) => a.text), ...all, ...r.experience.map((e) => e.summary ?? "")].map(plainText).join(" ");
  const { reads, clear } = proseLanguage(prose, limits, lexicon);
  if (reads && reads !== r.meta.lang)
    add(clear ? "error" : "warn", "meta.lang", "career.lint.language_mismatch", { lang: r.meta.lang, reads });

  if (!r.basics.phone) add("warn", "basics.phone", "career.lint.phone_missing");
  else if (!r.basics.phone.trim().startsWith("+")) add("info", "basics.phone", "career.lint.phone_country", { phone: r.basics.phone });
  if (!r.basics.workAuth) add("info", "basics.workAuth", "career.lint.work_auth_missing");

  if (r.sections?.length) {
    const listed = new Set(r.sections.map(builtinOf));
    for (const name of BUILTINS)
      if (!listed.has(name) && hasContent(r, name)) add("info", "sections", "career.lint.section_hidden", { name });
  }

  if (!r.basics.summary) add("info", "basics", "career.lint.summary_missing");
  return issues;
}
