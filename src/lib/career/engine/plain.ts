import { i18n } from "./i18n";
import type { Lang } from "./i18n";
import { letterParts } from "./letter";
import type { Resume } from "./schema";
import { headingOf, INLINE, labelOf, resolveSections } from "./sections";
import type { BuiltinName, Item, Tag } from "./sections";

const STACK: Record<Lang, string> = { en: "Tech stack", de: "Tech-Stack" };

function visible(s: string): string {
  return s
    .replace(/^\[[x ]\] /, "")
    .replace(INLINE, (m, code, label, text, url, bold) => {
      if (code !== undefined) return code;
      if (label !== undefined) return labelOf(label)?.text ?? m;
      if (bold !== undefined) return visible(bold);
      const t = visible(text);
      if (!/^https?:\/\//i.test(url)) return t;
      return t.replace(/\/$/, "") === url.replace(/\/$/, "") ? url : `${t} (${url})`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

const line = (parts: (string | undefined)[], sep = " | ") => parts.filter((p): p is string => !!p?.trim()).join(sep);
const bullets = (xs: string[]) => xs.map((b) => `- ${visible(b)}`);
const tagList = (tags: Tag[]) => tags.map((t) => t.text).join(", ");

const blocks = (bs: string[][]) => bs.filter((b) => b.length).map((b) => b.join("\n")).join("\n\n");

export function plainResume(r: Resume): string {
  const { date, range, availability } = i18n(r.meta.lang);
  const b = r.basics;
  const stack = (xs: string[]) => (xs.length ? [`${STACK[r.meta.lang]}: ${xs.join(", ")}`] : []);

  const header = [
    b.name,
    b.title,
    line([b.address ? b.address.join(", ") : b.location, b.email, b.phone, b.workAuth]),
    b.availability && availability(b.availability),
    ...b.links.map((l) => `${l.label}: ${l.url}`),
  ].filter(Boolean);

  const entries = (xs: { head: string; summary?: string; bullets?: string[]; extra?: string[] }[]) =>
    xs.map((e) => [e.head, ...(e.summary ? [visible(e.summary)] : []), ...bullets(e.bullets ?? []), ...(e.extra ?? [])]);

  const builtin: Record<BuiltinName, () => string[][]> = {
    summary: () => (b.summary ? [[visible(b.summary)]] : []),
    approach: () => (r.approach.length ? [r.approach.map((a) => `- ${a.title}: ${visible(a.text)}`)] : []),
    experience: () =>
      entries(
        r.experience.map((e) => ({
          head: line([`${e.role} — ${e.company}`, e.location, range(e.start, e.end)]),
          summary: e.summary,
          bullets: e.bullets,
          extra: stack(e.stack),
        })),
      ),
    projects: () =>
      entries(
        r.projects.map((p) => ({
          head: line([p.tagline ? `${p.name} — ${p.tagline}` : p.name, p.url]),
          bullets: p.bullets,
          extra: stack(p.stack),
        })),
      ),
    skills: () => (r.skills.length ? [r.skills.map((s) => `${s.group}: ${s.items.join(", ")}`)] : []),
    education: () =>
      entries(
        r.education.map((e) => ({
          head: line([`${e.degree} — ${e.school}`, e.location, range(e.start, e.end)]),
          summary: e.summary,
          bullets: e.bullets,
        })),
      ),
    certifications: () =>
      r.certifications.length ? [r.certifications.map((c) => line([c.issuer ? `${c.name} — ${c.issuer}` : c.name, c.date && date(c.date)]))] : [],
    languages: () => (r.languages.length ? [r.languages.map((l) => `${l.name}: ${l.level}`)] : []),
  };

  const custom = (items: Item[], layout: string): string[][] => {
    if (layout === "tags") return [[items.flatMap((it) => (it.kind === "tag" ? [it.tag.text] : [])).join(", ")]];
    const out: string[][] = [];
    let list: string[] = [];
    const flush = () => {
      if (list.length) out.push(list);
      list = [];
    };
    for (const it of items) {
      if (it.kind === "bullet") list.push(`- ${visible(it.text)}`);
      else if (it.kind === "check") list.push(`[${it.done ? "x" : " "}] ${visible(it.text)}`);
      else if (it.kind === "group") list.push(`${it.label}: ${it.items.join(", ")}`);
      else if (it.kind === "text") {
        flush();
        out.push([visible(it.text)]);
      }
      else if (it.kind === "entry") {
        flush();
        out.push([
          line([it.sub ? `${it.heading} — ${it.sub}` : it.heading, it.location, it.start && range(it.start, it.end), it.url]),
          ...(it.text ? [visible(it.text)] : []),
          ...bullets(it.bullets),
          ...(it.tags.length ? [tagList(it.tags)] : []),
        ]);
      }
    }
    flush();
    return out;
  };

  const sections = resolveSections(r).flatMap((s) => {
    const heading = s.kind === "builtin" ? headingOf(r, s.name) : s.title;
    const body = s.kind === "builtin" ? builtin[s.name]() : custom(s.items, s.layout);
    return body.length ? [[heading.toUpperCase(), "", blocks(body)].join("\n")] : [];
  });

  return `${[header.join("\n"), ...sections].join("\n\n")}\n`;
}

export function plainLetter(r: Resume, today: string): string {
  const l = letterParts(r, today);
  const b = r.basics;
  const sender = [b.name, ...(b.address ?? (b.location ? [b.location] : [])), line([b.phone, b.email])].filter(Boolean);
  return `${blocks([sender, l.recipient, [l.placeDate], l.subject ? [visible(l.subject)] : [], [l.salutation], ...l.body.map((p) => [visible(p)]), [l.closing, "", l.signer]])}\n`;
}
