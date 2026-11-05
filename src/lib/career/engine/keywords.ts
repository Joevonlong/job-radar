import type { CompiledLexicon } from "./compile-lexicon";

export interface Alias {
  re: RegExp;
  key: string;
  resumeOnly: boolean;
}
export interface Term {
  term: string;
  aliases: Alias[];
}
export type Dict = Term[];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const L = "\\p{L}\\p{N}_";

export const spellingKey = (s: string) => s.toLowerCase().replace(/[\s\-.]+/g, "").replace(/s$/, "");

function compile(raw: string): Alias {
  const resumeOnly = raw.startsWith("~");
  const exact = raw.startsWith("=");
  const alias = raw.replace(/^[=~]/, "");

  const body = alias.split("*").map((p) => p.split(/[ -]/).map(escape).join("[\\s-]")).join("\\p{L}*");

  const after = exact ? `(?![${L}+#&'’]|-(?:to|live|getter)\\b)` : `(?![${L}+#])`;
  const before = exact ? `(?<![${L}+#&])` : `(?<![${L}+#])`;
  return { re: new RegExp(`${before}${body}${after}`, exact ? "gu" : "giu"), key: spellingKey(alias.replace(/\*/g, "")), resumeOnly };
}

export function keywordTerms(entries: Record<string, string[]>): Dict {
  return Object.entries(entries).map(([term, aliases]) => ({ term, aliases: aliases.map(compile) }));
}

export interface Hit {
  term: string;
  forms: { text: string; key: string }[];
  count: number;
}

type Match = { term: string; s: number; e: number; key: string; text: string };
const inside = (m: Match, o: Match) => o !== m && o.s <= m.s && o.e >= m.e && o.e - o.s > m.e - m.s;

function matches(text: string, dict: Dict, jdSide: boolean): Match[] {
  const all: Match[] = [];
  for (const { term, aliases } of dict)
    for (const a of aliases)
      if (!(jdSide && a.resumeOnly)) for (const m of text.matchAll(a.re)) all.push({ term, s: m.index, e: m.index + m[0].length, key: a.key, text: m[0] });
  return all.filter((m) => !all.some((o) => o.term !== m.term && inside(m, o)));
}

export function termSpans(text: string, lexicon: CompiledLexicon): { term: string; s: number; e: number; text: string }[] {
  const ms = matches(text, lexicon.dict, true);
  return ms
    .filter((m) => !ms.some((o) => inside(m, o) || (o !== m && o.s === m.s && o.e === m.e && o.term < m.term)))
    .sort((a, b) => a.s - b.s)
    .map(({ term, s, e, text: t }) => ({ term, s, e, text: t }));
}

export function findHits(text: string, lexicon: CompiledLexicon, jdSide = false): Map<string, Hit> {
  const kept = matches(text, lexicon.dict, jdSide);
  const out = new Map<string, Hit>();
  for (const { term } of lexicon.dict) {
    const ms = kept.filter((m) => m.term === term);
    if (!ms.length) continue;
    const longest = ms.filter((m) => !ms.some((o) => inside(m, o))).sort((x, y) => x.s - y.s);
    const forms = new Map<string, string>();
    for (const m of jdSide ? longest : ms) if (!forms.has(m.key)) forms.set(m.key, m.text);
    let count = 0;
    let end = -1;
    for (const m of longest) {
      if (m.s >= end) {
        count++;
        end = m.e;
      }
    }
    out.set(term, { term, forms: [...forms].map(([key, t]) => ({ key, text: t })), count });
  }
  return out;
}

export function findTerms(text: string, lexicon: CompiledLexicon): Set<string> {
  return new Set(findHits(text, lexicon).keys());
}
