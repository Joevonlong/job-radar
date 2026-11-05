import { i18n } from "./i18n";
import { DICT, type Dict, findTerms } from "./keywords";
import type { Resume } from "./schema";
import { BUILTINS, builtinOf, hasContent, isCustom, plainText } from "./sections";

export interface Issue {
  level: "error" | "warn" | "info";
  where: string;
  message: string;
}

const MAX_BULLET = 200;
const MIN_BULLET = 40;
const MAX_BULLETS_PER_ENTRY = 5;
const MAX_GAP_MONTHS = 6;

export const PLACEHOLDER = /⟨[^⟩]*⟩|\bTODO\b|\bTBD\b|\bxxx\b/i;

const FILLER = [
  "spearheaded", "leveraged", "leveraging", "utilize", "utilized", "utilizing", "synergy", "synergies",
  "passionate", "results-driven", "detail-oriented", "cutting-edge", "state-of-the-art",
  "seamless", "seamlessly", "robust", "delve", "tapestry", "world-class", "best-in-class",
  "game-changer", "proven track record", "fast-paced", "team player", "hard-working", "go-getter",
  "think outside the box", "orchestrated", "revolutionized", "empowered", "holistic",
  "Leidenschaft", "leidenschaftlich~", "teamfähig~", "belastbar~", "motiviert~", "hochmotiviert~", "engagiert~",
  "zielorientiert~", "kommunikationsstark~", "innovativ~", "ganzheitlich~", "flexibel", "flexible[nmrs]",
];
export const FILLER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}-])(${FILLER.map((w) => w.replace(/~$/, "(e[nmrs]?)?")).join("|")})(?![\\p{L}\\p{N}-])`,
  "giu",
);

const PRONOUN = /^(I|we|my|ich|wir)(?![\p{L}\p{N}'’])/iu;
const WEAK = /^(?:(?:I|we|ich|wir)\s+)?(?:(?:was|were|am|bin|war)\s+)?(responsible for|worked on|helped|assisted|involved in|participated in|tasked with|verantwortlich für|zuständig für|mitarbeit (?:bei|an)|unterstützung (?:bei|von))(?![\p{L}])/iu;
const IRREGULAR = "built|made|done|given|taken|written|chosen|run|shown|led|sent|seen|held|brought|kept|won|found|grown|drawn|set|put|cut|begun|known|paid|sold|taught|thought|bought";
const PASSIVE_EN = new RegExp(`\\b(was|were|been)\\s+(?:\\w+ly\\s+)?(\\w+ed|(?:re)?(?:${IRREGULAR}))\\b`, "i");

const PASSIVE_DE = /\b(wurden?)\b[^,.;:]*?(?<![\p{L}])(\p{Ll}*ge\p{Ll}{2,}(?:t|en)|\p{Ll}{3,}iert|(?:be|ent|er|ver|zer)\p{Ll}{3,}t)(?![\p{L}])/u;

const EN_WORDS = new Set("the and of to for with on by from at as is was were that this our my have has their into".split(" "));
const DE_WORDS = new Set("der die das und mit für von zu im den dem des ein eine einer auf ist wurde als bei aus sich nicht auch über durch".split(" "));

export function proseLanguage(text: string): { reads?: "en" | "de"; clear: boolean } {
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  const de = words.filter((w) => DE_WORDS.has(w)).length;
  const reads = en + de >= 12 && en >= 3 * de ? "en" : en + de >= 12 && de >= 3 * en ? "de" : undefined;
  return { reads, clear: en + de >= 20 && (en >= 4 * de || de >= 4 * en) };
}

function strings(value: unknown, path = ""): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

const months = (d: string, edge: "start" | "end") => {
  if (d === "present") {
    const now = new Date();
    return now.getFullYear() * 12 + now.getMonth();
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

function experienceMonths(r: Resume): number | undefined {
  if (!r.experience.length || r.experience.some((e) => !e.end || e.start.startsWith("0000") || e.end.startsWith("0000"))) return undefined;
  const spans = r.experience.map((e) => [months(e.start, "start"), months(e.end!, "end")] as const).sort((a, b) => a[0] - b[0]);
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
    if (PLACEHOLDER.test(text)) out.push({ level: "error", where: path, message: `unfinished placeholder: "${text.slice(0, 70)}"` });
    else if (/\.(start|end|date)$/.test(path) && /^0000\b/.test(text)) out.push({ level: "error", where: path, message: `unfinished placeholder: date "${text}" — replace it with the real YYYY or YYYY-MM` });
  }
  return out;
}

export function lint(r: Resume, dict: Dict = DICT): Issue[] {
  const issues: Issue[] = [];
  const add = (level: Issue["level"], where: string, message: string) => issues.push({ level, where, message });

  const placeholders = placeholderIssues(r);

  for (const { path, text } of strings({ ...r, letter: undefined })) {
    const filler = [...new Set(text.match(FILLER_RE)?.map((w) => w.toLowerCase()))];
    if (filler.length) add("warn", path, `filler wording: ${filler.join(", ")} — say what you did and what changed`);
  }

  if (placeholders.length)
    return [
      ...placeholders,
      { level: "info", where: "placeholders", message: `unfinished placeholders: ${placeholders.length} left — fill them in first; the other suggestions (phone, skills, years, numbers …) show up once none is left` },
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
    if (n > MAX_BULLET) add("warn", where, `bullet is ${n} chars (> ${MAX_BULLET}): "${plainText(b).slice(0, 50)}…" — split it or cut the setup`);
  };
  const tooMany = (where: string, n: number) => {
    if (n > MAX_BULLETS_PER_ENTRY) add("info", where, `${n} bullets — keep the strongest ${MAX_BULLETS_PER_ENTRY}`);
  };

  const seen = new Map<string, string>();
  for (const { where, bullets } of [...entries, ...custom]) {
    const openers = new Map<string, number>();
    bullets.forEach((b, k) => {
      const at = `${where}.bullets[${k}]`;
      const text = plainText(b).trim();
      longBullet(at, b);
      if (text.length < MIN_BULLET) add("info", at, `bullet is only ${text.length} chars: "${text}" — say what changed as a result (scale, %, time)`);
      const pronoun = text.match(PRONOUN)?.[0];
      if (pronoun) add("warn", at, `starts with "${pronoun}" — drop the pronoun and open with the action verb ("Built…", "Cut…")`);
      const weak = text.match(WEAK)?.[1];
      if (weak) add("warn", at, `weak opener "${weak}" — say what you did (Built, Led, Cut…) and what it changed`);
      const passive = text.match(PASSIVE_EN)?.[0] ?? text.match(PASSIVE_DE)?.[0];
      if (passive) add("info", at, `passive voice ("${passive}") — make yourself the subject and open with the verb`);
      const key = squash(b);
      if (key && seen.has(key)) add("warn", at, `same bullet as ${seen.get(key)} — keep one`);
      else if (key) seen.set(key, at);
      const verb = text.replace(PRONOUN, "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^\p{L}-]/gu, "");
      if (verb) openers.set(verb, (openers.get(verb) ?? 0) + 1);
    });
    for (const [verb, n] of openers)
      if (n > 2) add("info", where, `${n} bullets start with "${verb}" — vary the verbs so each reads as a different result`);
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
    add("info", "bullets", `${quantified}/${all.length} contain a number — aim for at least half (scale, %, time, count)`);
  const latest = r.experience.reduce((best, e, i) => (months(e.start, "start") > months(r.experience[best].start, "start") ? i : best), 0);
  const recent = r.experience[latest];
  if (recent?.bullets.length && !recent.bullets.some((b) => /\d/.test(b)))
    add("warn", `experience[${latest}]`, `no bullet in your most recent role (${recent.company}) has a number — add scale, %, time or count to at least one`);

  r.experience.forEach((e, i) => {
    if (e.end === undefined) add("warn", `experience[${i}]`, `no "end" date — write end: present if you still work at ${e.company}, otherwise the real end month (now it reads as a one-month job)`);
    const next = r.experience[i + 1];
    if (next && months(next.start, "start") > months(e.start, "start"))
      add("warn", `experience[${i + 1}]`, `${next.company} started after ${e.company} but is listed below it — list experience newest first`);
  });

  const byStart = r.experience.every((e) => e.end) ? [...r.experience].sort((a, b) => months(a.start, "start") - months(b.start, "start")) : [];
  let covered: { end: number; company: string } | undefined;
  for (const e of byStart) {
    const gap = covered ? months(e.start, "start") - covered.end - 1 : 0;
    if (covered && gap > MAX_GAP_MONTHS)
      add("info", "experience", `${gap}-month gap between ${covered.company} and ${e.company} — be ready to explain it, or add what you did then (studies, a project, a course)`);
    const end = months(e.end!, "end");
    if (!covered || end > covered.end) covered = { end, company: e.company };
  }

  const total = experienceMonths(r);
  if (total !== undefined) {
    const years = Math.round((total / 12) * 10) / 10;
    const claims = [{ where: "basics.summary", text: r.basics.summary ?? "" }, ...r.approach.map((a, i) => ({ where: `approach[${i}].text`, text: a.text }))];
    for (const { where, text } of claims)
      for (const m of plainText(text).matchAll(YEARS)) {
        const n = Number(m[2]);
        const atLeast = !!(m[3] || /^(over|more than|über|mehr als)$/i.test(m[1] ?? ""));
        const whole = WHOLE_CAREER.test(plainText(text).slice(m.index + m[0].length, m.index + m[0].length + 60));
        if (n >= years + 1)
          add("warn", where, `"${m[0].trim()}" — your experience dates add up to ${years} years; claim what the dates show (or list the missing role)`);
        else if (whole && !atLeast && years >= n + 1)
          add("warn", where, `"${m[0].trim()}" — your experience dates add up to ${years} years; update the number (it goes stale while a role is "present")`);
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
    add("info", `skills[${i}].group`, `skill group "${g.group}" is also a section heading — a parser may start a new section there; rename it${lang ? ' (e.g. "Programming languages" / "Programmiersprachen")' : ""}`);
  });

  const body = [
    ...r.experience.flatMap((e) => [e.role, e.summary ?? "", ...e.bullets, ...e.stack]),
    ...r.projects.flatMap((p) => [p.name, p.tagline ?? "", ...p.bullets, ...p.stack]),
  ].map(plainText).join("\n");
  const bodyTerms = findTerms(body, dict);
  const lowerBody = body.toLowerCase();
  r.skills.forEach((g, i) =>
    g.items.forEach((item, j) => {
      const terms = findTerms(item, dict);
      const shown = terms.size ? [...terms].some((t) => bodyTerms.has(t)) : lowerBody.includes(item.replace(/\s*\(.*?\)\s*/g, "").trim().toLowerCase());
      if (!shown) add("info", `skills[${i}].items[${j}]`, `"${item}" is only in skills — show it in an experience or project bullet, or be ready to back it up`);
    }),
  );

  const prose = [r.basics.summary ?? "", ...r.approach.map((a) => a.text), ...all, ...r.experience.map((e) => e.summary ?? "")].map(plainText).join(" ");
  const { reads, clear } = proseLanguage(prose);
  if (reads && reads !== r.meta.lang)
    add(clear ? "error" : "warn", "meta.lang", `meta.lang is "${r.meta.lang}" but the text reads as ${reads === "en" ? "English" : "German"} — headings and dates follow meta.lang; translate the text or set lang: ${reads}`);

  if (!r.basics.phone) add("warn", "basics.phone", "no phone number — add one in international format (+49 …)");
  else if (!r.basics.phone.trim().startsWith("+")) add("info", "basics.phone", `phone "${r.basics.phone}" has no country code — write it as +49 …`);
  if (!r.basics.workAuth) add("info", "basics.workAuth", "no work authorization line — if you have the right to work in the country, say so in one line");

  if (r.sections?.length) {
    const listed = new Set(r.sections.map(builtinOf));
    for (const name of BUILTINS)
      if (!listed.has(name) && hasContent(r, name)) add("info", "sections", `${name} has content but is not listed in sections — it won't be shown`);
  }

  if (!r.basics.summary) add("info", "basics", "no summary");
  return issues;
}
