import { getDocumentProxy } from "unpdf";
import { signDate } from "./blocks";
import { i18n } from "./i18n";
import type { Diagnostic, Issue } from "./finding";
import type { CheckLimits } from "./limits";
import { bareUrl } from "./md";
import type { Resume } from "./schema";
import { hasContent, headingOf, type Item, plainText, resolveSections } from "./sections";

export async function countPages(pdf: Uint8Array): Promise<number> {
  const doc = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  try {
    return doc.numPages;
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** Each page ends with a newline so text at a page boundary cannot join into one word. */
export async function extractPages(pdf: Uint8Array): Promise<string[]> {
  const doc = await getDocumentProxy(new Uint8Array(pdf), { verbosity: 0 });
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items } = await page.getTextContent();
      let out = "";
      for (const i of items) if ("str" in i) out += i.str + (i.hasEOL ? "\n" : "");
      pages.push(out.endsWith("\n") ? out : `${out}\n`);
      page.cleanup();
    }
    return pages;
  } finally {
    await doc.loadingTask.destroy();
  }
}

export const extractText = async (pdf: Uint8Array): Promise<string> => (await extractPages(pdf)).join("");

const norm = (s: string) => plainText(s).replace(/\s+/g, " ").toLowerCase().trim();

const squash = (s: string) => s.replace(/\s+/g, "");

type Snip = string | { plain: string };
const P = (plain: string): Snip => ({ plain });

function itemTexts(it: Item): Snip[] {
  switch (it.kind) {
    case "bullet":
    case "check":
    case "text":
      return [it.text];
    case "group":
      return [P(it.label), P(it.items.join(", "))];
    case "tag":
      return [P(it.tag.text)];
    case "entry":
      return [P(it.heading), ...(it.sub ? [P(it.sub)] : []), ...(it.text ? [it.text] : []), ...it.bullets, ...it.tags.map((t) => P(t.text))];
  }
}

function chains(r: Resume): { name: string; seq: Snip[] }[] {
  return resolveSections(r).flatMap((s): { name: string; seq: Snip[] }[] => {
    if (s.kind === "custom") return [{ name: s.title, seq: s.items.flatMap(itemTexts) }];
    if (s.name === "experience") return [{ name: s.name, seq: r.experience.flatMap((e) => [P(e.role), ...e.bullets]) }];
    if (s.name === "projects") return [{ name: s.name, seq: r.projects.flatMap((p) => [P(p.name), ...p.bullets]) }];
    return [];
  });
}

export const canon = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[\s\-‐-―−]+/g, "");

export const withoutFolios = (text: string) => text.replace(/^[ \t]*\d+[ \t]*\/[ \t]*\d+[ \t]*$/gm, "");

export function present(hay: string, needle: string, limits: CheckLimits): boolean {
  let rest = needle;
  for (let piece = 1; piece <= limits.maxPieces; piece++) {
    if (hay.includes(rest)) return true;

    let lo = 0;
    let hi = rest.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (hay.includes(rest.slice(0, mid))) lo = mid;
      else hi = mid - 1;
    }
    if (lo < limits.minPiece) return false;
    rest = rest.slice(lo);
  }
  return false;
}

interface Shown {
  where: string;
  text: string;
  md?: boolean;
}

function itemShown(it: Item, at: string, range: (s: string, e?: string) => string): Shown[] {
  switch (it.kind) {
    case "bullet":
    case "check":
    case "text":
      return [{ where: at, text: it.text, md: true }];
    case "group":
      return [{ where: `${at}.label`, text: it.label }, ...it.items.map((x, k) => ({ where: `${at}.items[${k}]`, text: x }))];
    case "tag":
      return [{ where: at, text: it.tag.text }];
    case "entry":
      return [
        { where: `${at}.heading`, text: it.heading },
        ...(it.sub ? [{ where: `${at}.sub`, text: it.sub }] : []),
        ...(it.location ? [{ where: `${at}.location`, text: it.location }] : []),
        ...(it.start ? [{ where: `${at}.${it.end ? "start" : "date"}`, text: range(it.start, it.end) }] : []),
        ...(it.text ? [{ where: `${at}.text`, text: it.text, md: true }] : []),
        ...it.bullets.map((b, k) => ({ where: `${at}.bullets[${k}]`, text: b, md: true })),
        ...it.tags.map((t, k) => ({ where: `${at}.tags[${k}]`, text: t.text })),
      ];
  }
}

export function shownContent(r: Resume, day: string): Shown[] {
  const l10n = i18n(r.meta.lang);
  const { range, date } = l10n;
  const b = r.basics;
  const opt = (where: string, text: string | undefined, md = false): Shown[] => (text ? [{ where, text, md }] : []);
  const out: Shown[] = [
    { where: "basics.title", text: b.title },
    ...(b.address ? b.address.map((line, i) => ({ where: `basics.address${b.address!.length > 1 ? `[${i}]` : ""}`, text: line })) : opt("basics.location", b.location)),
    ...opt("basics.workAuth", b.workAuth),
    ...opt("basics.availability", b.availability && l10n.availability(b.availability)),
    ...b.links.map((l, i) => ({ where: `basics.links[${i}]`, text: bareUrl(l.url) })),
  ];
  for (const s of resolveSections(r)) {
    if (s.kind === "custom") {
      out.push({ where: `sections[${s.index}].title`, text: s.title });
      s.items.forEach((it, j) => out.push(...itemShown(it, `sections[${s.index}].items[${j}]`, range)));
      continue;
    }
    switch (s.name) {
      case "summary":
        out.push(...opt("basics.summary", b.summary, true));
        break;
      case "approach":
        r.approach.forEach((a, i) => out.push({ where: `approach[${i}].title`, text: a.title }, { where: `approach[${i}].text`, text: a.text, md: true }));
        break;
      case "experience":
        r.experience.forEach((e, i) => {
          const at = `experience[${i}]`;
          out.push({ where: `${at}.role`, text: e.role }, { where: `${at}.company`, text: e.company }, { where: `${at}.start`, text: range(e.start, e.end) });
          out.push(...opt(`${at}.location`, e.location), ...opt(`${at}.summary`, e.summary, true));
          e.bullets.forEach((x, k) => out.push({ where: `${at}.bullets[${k}]`, text: x, md: true }));
          e.stack.forEach((x, k) => out.push({ where: `${at}.stack[${k}]`, text: x }));
        });
        break;
      case "projects":
        r.projects.forEach((p, i) => {
          const at = `projects[${i}]`;
          out.push({ where: `${at}.name`, text: p.name }, ...opt(`${at}.tagline`, p.tagline), ...opt(`${at}.url`, p.url && bareUrl(p.url)));
          p.bullets.forEach((x, k) => out.push({ where: `${at}.bullets[${k}]`, text: x, md: true }));
          p.stack.forEach((x, k) => out.push({ where: `${at}.stack[${k}]`, text: x }));
        });
        break;
      case "skills":
        r.skills.forEach((g, i) => {
          out.push({ where: `skills[${i}].group`, text: g.group });
          g.items.forEach((x, k) => out.push({ where: `skills[${i}].items[${k}]`, text: x }));
        });
        break;
      case "education":
        r.education.forEach((e, i) => {
          const at = `education[${i}]`;
          out.push({ where: `${at}.degree`, text: e.degree }, { where: `${at}.school`, text: e.school }, { where: `${at}.start`, text: range(e.start, e.end) });
          out.push(...opt(`${at}.location`, e.location), ...opt(`${at}.summary`, e.summary, true));
          e.bullets.forEach((x, k) => out.push({ where: `${at}.bullets[${k}]`, text: x, md: true }));
        });
        break;
      case "certifications":
        r.certifications.forEach((c, i) =>
          out.push({ where: `certifications[${i}].name`, text: c.name }, ...opt(`certifications[${i}].issuer`, c.issuer), ...opt(`certifications[${i}].date`, c.date && date(c.date))),
        );
        break;
      case "languages":
        r.languages.forEach((l, i) => out.push({ where: `languages[${i}].name`, text: l.name }, { where: `languages[${i}].level`, text: l.level }));
        break;
    }
  }

  out.push(...opt("meta.signature", signDate(r, { ...l10n, today: day })));
  return out;
}

export function missingContent(r: Resume, text: string, day: string, limits: CheckLimits): Issue[] {
  const hay = canon(withoutFolios(text));
  return shownContent(r, day).flatMap(({ where, text: raw, md }): Issue[] => {
    const visible = md ? plainText(raw) : raw;
    const needle = canon(visible);
    if (!needle || present(hay, needle, limits)) return [];
    const short = visible.replace(/\s+/g, " ").trim();
    return [{ level: "error", where, code: "career.extract.content_missing", params: { text: short.length > 60 ? `${short.slice(0, 57)}…` : short } }];
  });
}

const spaced = (s: string) => s.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/[­​-‍⁠﻿]/g, "").replace(/\s+/g, " ");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function headingIn(text: string, title: string): { state: "ok" | "split" | "missing"; seen?: string } {
  const hay = spaced(text);
  const ws = spaced(title).trim().split(" ");
  const whole = ws.join(" ");
  const B = "(?<![\\p{L}\\p{N}])";
  const E = "(?![\\p{L}\\p{N}])";
  for (const m of hay.matchAll(new RegExp(B + [...ws.join("")].map(reEsc).join("\\s*") + E, "gu")))
    if (m[0].replace(/\s+/g, " ") !== whole) return { state: "split", seen: m[0].toUpperCase() };
  return new RegExp(B + ws.map(reEsc).join("\\s+") + E, "u").test(hay) ? { state: "ok" } : { state: "missing" };
}

export function parserProblems(r: Resume, text: string): Issue[] {
  const out = identityProblems(r, text);
  headingProblems(r, text, out);
  return out;
}

export function identityProblems(r: Resume, text: string): Issue[] {
  const out: Issue[] = [];
  const hay = squash(text.toLowerCase());
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  if (!squash(first.toLowerCase()).includes(squash(r.basics.name.toLowerCase())))
    out.push({ level: "error", where: "basics.name", code: "career.extract.name_first", params: { text: first.slice(0, 50) } });
  for (const key of ["email", "phone"] as const) {
    const v = r.basics[key];
    if (v && !hay.includes(squash(v.toLowerCase())))
      out.push({ level: "error", where: `basics.${key}`, code: "career.extract.contact_missing", params: { key, text: v } });
  }
  return out;
}

function headingProblems(r: Resume, text: string, out: Issue[]): void {
  for (const s of resolveSections(r)) {
    const title = s.kind === "custom" ? s.title : s.name !== "summary" && hasContent(r, s.name) ? headingOf(r, s.name) : undefined;
    if (!title) continue;
    const where = s.kind === "custom" ? `sections[${s.index}].title` : s.name;
    const h = headingIn(text, title);
    if (h.state === "split")
      out.push({ level: "error", where, code: "career.extract.heading_split", params: { title, seen: h.seen! } });
    else if (h.state === "missing")
      out.push({ level: "warn", where, code: "career.extract.heading_missing", params: { title } });
  }
}

export function readingOrderProblem(r: Resume, text: string): Diagnostic | null {
  const hay = squash(text.toLowerCase());
  for (const { name, seq } of chains(r)) {
    let at = 0;
    for (const raw of seq) {
      const full = typeof raw === "string" ? norm(raw) : raw.plain.replace(/\s+/g, " ").toLowerCase().trim();
      const s = squash(full).slice(0, 40);
      if (!s) continue;
      const i = hay.indexOf(s, at);
      if (i < 0) return { code: hay.includes(s) ? "career.extract.order_wrong" : "career.extract.order_missing", params: { name, text: `${full.slice(0, 40).trim()}…` } };
      at = i + s.length;
    }
  }
  return null;
}
