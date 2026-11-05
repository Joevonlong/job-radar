import { i18n } from "./i18n";
import type { Resume } from "./schema";

export const BUILTINS = ["summary", "approach", "experience", "projects", "skills", "education", "certifications", "languages"] as const;
export type BuiltinName = (typeof BUILTINS)[number];

export const TAG_COLORS = ["accent", "blue", "green", "orange", "red", "gray"] as const;
export type TagColor = (typeof TAG_COLORS)[number];
export interface Tag {
  text: string;
  color: TagColor;
}

const isColor = (s: string): s is TagColor => (TAG_COLORS as readonly string[]).includes(s);

export function parseTag(s: string): Tag {
  const i = s.lastIndexOf(":");
  if (i >= 0) {
    const color = s.slice(i + 1).trim();
    const text = s.slice(0, i).trim();
    if (isColor(color) && text) return { text, color };
  }
  return { text: s.trim(), color: "accent" };
}

export type Item =
  | { kind: "bullet"; text: string }
  | { kind: "check"; text: string; done: boolean }
  | { kind: "group"; label: string; items: string[] }
  | { kind: "text"; text: string }
  | {
      kind: "entry";
      heading: string;
      sub?: string;
      url?: string;
      start?: string;
      end?: string;
      location?: string;
      text?: string;
      bullets: string[];
      tags: Tag[];
    }
  | { kind: "tag"; tag: Tag };

export interface CustomSection {
  title: string;
  layout: "list" | "grid" | "tags";
  columns: number;
  side: "main" | "aside";
  items: Item[];
}

export interface BuiltinRef {
  use: BuiltinName;
  title: string;
}

export type SectionSpec = BuiltinName | BuiltinRef | CustomSection;

export const isCustom = (s: SectionSpec): s is CustomSection => typeof s !== "string" && !("use" in s);

export const builtinOf = (s: SectionSpec): BuiltinName | undefined => (typeof s === "string" ? s : "use" in s ? s.use : undefined);

export type Section = { kind: "builtin"; name: BuiltinName } | ({ kind: "custom"; index: number } & CustomSection);

export function resolveSections(r: Resume): Section[] {
  const list: SectionSpec[] = r.sections?.length ? r.sections : [...BUILTINS];
  return list.map((s, index): Section => (isCustom(s) ? { kind: "custom", index, ...s } : { kind: "builtin", name: builtinOf(s)! }));
}

export function headingOf(r: Resume, name: BuiltinName): string {
  const own = r.sections?.find((s): s is BuiltinRef => typeof s !== "string" && "use" in s && s.use === name);
  return own?.title ?? i18n(r.meta.lang).t[name];
}

export const headingsOf = (r: Resume) => Object.fromEntries(BUILTINS.map((n) => [n, headingOf(r, n)])) as Record<BuiltinName, string>;

export const INLINE = /`(.+?)`|\[\[([^\[\]\n]+)\]\]|\[([^\[\]\n]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*/g;

export const labelOf = (inner: string): Tag | undefined => {
  const m = /^\s*:(.*)$/.exec(inner);
  return !inner.trim() || (m && isColor(m[1].trim())) ? undefined : parseTag(inner);
};

export function plainText(s: string): string {
  return s
    .replace(/^\[[x ]\] /, "")
    .replace(INLINE, (m, code, label, text, _url, bold) =>
      code !== undefined ? code : label !== undefined ? (labelOf(label)?.text ?? m) : text !== undefined ? plainText(text) : plainText(bold),
    );
}

export function hasContent(r: Resume, name: BuiltinName): boolean {
  return name === "summary" ? !!r.basics.summary : r[name].length > 0;
}

export interface HeadingHint {
  heading: string;
  own: boolean;
  state: "shown" | "unlisted" | "empty" | "lead";
  order?: number;
}

export function headingHints(r: Resume): Record<BuiltinName, HeadingHint> {
  const sections = resolveSections(r);
  const listed = new Set(sections.flatMap((s) => (s.kind === "builtin" ? [s.name] : [])));
  const order = new Map<BuiltinName, number>();
  let n = 0;
  for (const s of sections) {
    if (s.kind === "custom") n++;
    else if (hasContent(r, s.name) && !(s.name === "summary" && r.meta.theme === "split")) order.set(s.name, ++n);
  }
  const own = (name: BuiltinName) => !!r.sections?.some((s) => typeof s !== "string" && "use" in s && s.use === name);
  return Object.fromEntries(
    BUILTINS.map((name): [BuiltinName, HeadingHint] => {
      const state = !listed.has(name) ? "unlisted" : !hasContent(r, name) ? "empty" : order.has(name) ? "shown" : "lead";
      return [name, { heading: headingOf(r, name), own: own(name), state, ...(state === "shown" ? { order: order.get(name) } : {}) }];
    }),
  ) as Record<BuiltinName, HeadingHint>;
}
