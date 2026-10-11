import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { AnyNode, Element } from "domhandler";

import type { AlertWorkplace } from "./types";

/**
 * Helpers shared by the platform parsers. Alert emails are table-based marketing HTML whose class
 * names are obfuscated and change without notice, so parsers do not rely on classes: they find the
 * links that identify a job, group them per job, and read the text lines after the title.
 */

export function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}

// ---------------------------------------------------------------- text

const cp = (n: number): string => String.fromCodePoint(n);
// zero-width characters, soft hyphen, CGJ, fillers (preheader padding)
const INVISIBLE = new RegExp(`[${cp(0x200b)}-${cp(0x200f)}${cp(0xad)}${cp(0x34f)}${cp(0x2060)}${cp(0xfeff)}${cp(0x115f)}${cp(0x1160)}${cp(0x3164)}]`, "gu");
const SPACE_LIKE = new RegExp(`[${cp(0xa0)}${cp(0x2007)}${cp(0x202f)}]`, "g");
const BLOCK_TAGS = "p, div, tr, td, th, li, ul, ol, h1, h2, h3, h4, h5, h6, table, section, article";

export function cleanText(value: string): string {
  return value.replace(INVISIBLE, "").replace(SPACE_LIKE, " ").replace(/\s+/g, " ").trim();
}

/** The visible text lines of an element: block elements and <br> start a new line, hidden preheaders are dropped. */
export function textLines($: CheerioAPI, element: AnyNode): string[] {
  const clone = $(element).clone();
  clone.find("style, script, head, title").remove();
  clone.find('[hidden], [style*="display:none"], [style*="display: none"], [style*="max-height:0"], [style*="max-height: 0"]').remove();
  clone.find("br").replaceWith("\n");
  clone.find(BLOCK_TAGS).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  return clone
    .text()
    .split("\n")
    .map(cleanText)
    .filter((line) => line.length > 0);
}

/** A link's own visible text (image-only links give ""). */
export function linkText($: CheerioAPI, anchor: AnyNode): string {
  return cleanText($(anchor).text());
}

// ---------------------------------------------------------------- links

/** Query parameters that only carry tracking; removed when a link is normalized. */
const TRACKING_PARAM = /^(?:utm_.*|trk.*|tracking.*|refid|midtoken|midsig|ref|source|src|campaign|cid|eid|eml|mc_.*|fbclid|gclid|lipi|otptoken|trackingid|alert.*|from|qd|rd|tk|xtor|wt_.*|sc_.*|jobalertid|savedsearchid)$/i;
/** Parameters that hold the real destination of a redirect wrapper. */
const REDIRECT_PARAM = ["url", "u", "target", "redirect", "redirect_url", "redirecturl", "dest", "destination", "link", "l"];

function parseHttp(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The destination of a redirect wrapper (`...?url=<encoded>`), possibly nested; the link itself otherwise. */
export function unwrapLink(href: string): URL | null {
  let current = parseHttp(href);
  for (let depth = 0; current && depth < 3; depth += 1) {
    let inner: URL | null = null;
    for (const name of REDIRECT_PARAM) {
      for (const [key, value] of current.searchParams) {
        if (key.toLowerCase() !== name) continue;
        const candidate = parseHttp(value);
        if (candidate) {
          inner = candidate;
          break;
        }
      }
      if (inner) break;
    }
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** A stable link for storage: no fragment, no tracking parameters, sorted remaining parameters, no trailing-slash noise. */
export function canonicalUrl(url: URL): string {
  const out = new URL(url.toString());
  out.hash = "";
  const kept = [...out.searchParams.entries()].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  out.search = "";
  for (const [key, value] of kept) out.searchParams.append(key, value);
  out.host = out.host.toLowerCase();
  return out.toString();
}

/** Header / footer / search links: a block that holds one is wider than a single card. */
const CHROME_LINK = /unsubscribe|abmelden|abbestellen|opt-?out|psettings|preferences|privacy|datenschutz|impressum|\/help\b|\/legal|\/settings|notifications|\/jobs\/search|\/jobs\/find|\/alerts?\b|alle[-_]?jobs|see[-_]?all|\/comm\/feed|\/feed\//i;

export interface JobLink {
  /** Groups the anchors of one job. */
  key: string;
  /** Platform job id, null when the link has none (the canonical link then identifies the job). */
  id: string | null;
  url: string;
}

export interface LinkMatcher {
  /** `url` is the unwrapped destination of the anchor; null = this link is not a job link. */
  (url: URL): JobLink | null;
}

export interface CardCandidate {
  link: JobLink;
  title: string;
  /** Visible text lines of the card from the title on (the title line itself excluded). */
  lines: string[];
}

/**
 * Find the job cards: every anchor whose destination `match` recognises is a job link; the anchors
 * of one job (logo, title, "view job" button) are grouped by key. The card is the largest ancestor
 * of the first anchor that holds no other job's link; its text lines after the title line are the
 * card's details. Cards without a readable title are skipped.
 */
export function findCards($: CheerioAPI, match: LinkMatcher): CardCandidate[] {
  interface Group {
    link: JobLink;
    anchors: Element[];
  }
  const groups = new Map<string, Group>();
  $("a[href]").each((_, node) => {
    const href = $(node).attr("href");
    if (!href) return;
    const destination = unwrapLink(href);
    const link = destination ? match(destination) : null;
    if (!link) return;
    const group = groups.get(link.key);
    if (group) group.anchors.push(node);
    else groups.set(link.key, { link, anchors: [node] });
  });

  const keyOf = new Map<Element, string>();
  for (const [key, group] of groups) for (const anchor of group.anchors) keyOf.set(anchor, key);

  const cards: CardCandidate[] = [];
  for (const [key, group] of groups) {
    const titleAnchor = group.anchors.find((a) => linkText($, a).length > 0);
    if (!titleAnchor) continue;
    const title = linkText($, titleAnchor);

    // climb while the parent still holds only this job's links
    let container: Element = group.anchors[0] as Element;
    for (let depth = 0; depth < 10; depth += 1) {
      const parent = container.parent;
      if (!parent || parent.type !== "tag" || parent.name === "body" || parent.name === "html") break;
      const foreign = $(parent)
        .find("a[href]")
        .toArray()
        .some((a) => {
          const other = keyOf.get(a);
          if (other !== undefined) return other !== key;
          return CHROME_LINK.test(unwrapLink($(a).attr("href") ?? "")?.toString() ?? $(a).attr("href") ?? "");
        });
      if (foreign) break;
      container = parent;
    }

    const lines = textLines($, container);
    const at = lines.findIndex((line) => line === title || line.startsWith(title));
    const after = at >= 0 ? lines.slice(at + 1) : lines.filter((line) => line !== title);
    // a title shown inside a longer line ("Title · Company") keeps the rest as the first detail
    if (at >= 0 && lines[at] !== title) after.unshift(lines[at]!.slice(title.length).replace(/^[\s·|\-–—]+/, ""));
    cards.push({ link: group.link, title, lines: after.filter((l) => l.length > 0) });
  }
  return cards;
}

// ---------------------------------------------------------------- card detail helpers

const SALARY_LINE = /(?:[€$£]|\bEUR\b|\bCHF\b)\s?\d|\d\s?(?:[€$£]|\bEUR\b|\bCHF\b)|\d+\s?[kK]\b.*(?:\/|pro|per|a|im)\s?(?:yr|year|jahr|monat|month)|\b(?:gehalt|salary|vergütung)\b[^\n]*\d/i;

export function isSalaryLine(line: string): boolean {
  return SALARY_LINE.test(line) && line.length <= 120;
}

const WORKPLACE_PATTERNS: ReadonlyArray<readonly [RegExp, AlertWorkplace]> = [
  [/\(?\b(?:remote|fully remote|100\s?%\s?remote|vollständig remote|komplett remote)\b\)?/i, "remote"],
  [/\(?\b(?:hybrid|hybrides arbeiten)\b\)?/i, "hybrid"],
  [/\(?\b(?:on-?site|vor ort|präsenz)\b\)?/i, "onsite"],
];

/** An explicit Remote / Hybrid / On-site word in `text`, with the word removed from the returned text. */
export function extractWorkplace(text: string): { text: string; workplace: AlertWorkplace | null } {
  for (const [pattern, workplace] of WORKPLACE_PATTERNS) {
    if (pattern.test(text)) {
      const stripped = cleanText(text.replace(pattern, " ").replace(/[\s,·|\-–—()]+$/g, "").replace(/^[\s,·|\-–—()]+/g, ""));
      return { text: stripped, workplace };
    }
  }
  return { text, workplace: null };
}

/** Lines that are UI chrome or status badges, never company / location / snippet. */
export function matchesAny(line: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(line));
}

/** Longest teaser kept in a payload. */
export const MAX_SNIPPET_CHARS = 1200;

export function snippetOf(lines: readonly string[]): string | null {
  const text = lines.join("\n").trim();
  return text.length > 0 ? text.slice(0, MAX_SNIPPET_CHARS) : null;
}
