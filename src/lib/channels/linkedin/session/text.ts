import type { AnyNode } from "domhandler";
import * as cheerio from "cheerio";

import { currencyCodeOf } from "../../currency";
import { SALARY_PERIODS } from "../../types";

/** Text helpers of the LinkedIn page parsers: whitespace, HTML to structured text, relative times, salary lines. */

export function squash(value: string | null | undefined): string | null {
  const text = value?.replace(/[\s ]+/g, " ").trim();
  return text ? text : null;
}

const BLOCK_TAGS = new Set(["p", "div", "section", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "li"]);

/**
 * A description element as plain text that keeps its structure: blocks become blank-line separated paragraphs, list items "- " lines,
 * `<br>` a line break. (LinkedIn's description is a flat run of `<p>`, `<ul>`, `<strong>` and `<br>`.)
 */
export function elementToText(element: AnyNode | cheerio.Cheerio<AnyNode>): string {
  const out: string[] = [];
  const nodes = "toArray" in element ? element.toArray() : [element];
  const walk = (node: AnyNode): void => {
    if (node.type === "text") {
      out.push(node.data);
      return;
    }
    if (node.type !== "tag") return;
    const tag = node.name.toLowerCase();
    if (tag === "script" || tag === "style") return;
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "li") out.push("\n- ");
    else if (BLOCK_TAGS.has(tag)) out.push("\n\n");
    for (const child of node.children) walk(child);
    if (BLOCK_TAGS.has(tag) && tag !== "li") out.push("\n\n");
  };
  for (const node of nodes) walk(node);
  return out
    .join("")
    .replace(/\r/g, "")
    .replace(/[\t  ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** An HTML fragment as structured plain text (see `elementToText`). */
export function htmlFragmentToText(html: string): string {
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  return elementToText($("#__root"));
}

// ---------------------------------------------------------------- relative times

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Length of a time unit word of LinkedIn's English or German UI. */
function unitMs(word: string): number | null {
  const w = word.toLowerCase();
  if (/^(?:second|sekunde)/.test(w)) return 1000;
  if (/^(?:minute|min)/.test(w)) return MINUTE;
  if (/^(?:hour|stunde|std)/.test(w)) return HOUR;
  if (/^(?:day|tag)/.test(w)) return DAY;
  if (/^(?:week|woche)/.test(w)) return 7 * DAY;
  if (/^(?:month|monat)/.test(w)) return 30 * DAY;
  if (/^(?:year|jahr)/.test(w)) return 365 * DAY;
  return null;
}

/**
 * "2 hours ago", "Reposted 3 days ago", "vor 5 Minuten", "1 week ago" -> the moment it means, relative to `now`; "just now" /
 * "gerade eben" / "today" / "heute" -> `now`. null when the text is not a relative time. The result is approximate by nature
 * (LinkedIn rounds), which is fine for a "posted at" hint.
 */
export function relativeTimeToDate(text: string | null | undefined, now: Date): Date | null {
  const value = squash(text)?.toLowerCase();
  if (!value) return null;
  if (/\b(?:just now|gerade eben|jetzt|today|heute)\b/.test(value)) return new Date(now.getTime());
  if (/\b(?:yesterday|gestern)\b/.test(value)) return new Date(now.getTime() - DAY);
  const match = /(?:\b(\d+|an?|ein(?:e[mnrs]?)?)\s*(?:\+\s*)?)([a-zäöü]+)\b/.exec(value.replace(/\bvor\b/, ""));
  if (!match) return null;
  const amountText = match[1] ?? "";
  const unit = unitMs(match[2] ?? "");
  if (unit === null) return null;
  const amount = /^\d+$/.test(amountText) ? Number(amountText) : 1;
  return new Date(now.getTime() - amount * unit);
}

// ---------------------------------------------------------------- salary

export interface ParsedSalary {
  min: number | null;
  max: number | null;
  currency: string;
  period: (typeof SALARY_PERIODS)[number];
  raw: string;
}

const PERIOD_WORDS: ReadonlyArray<readonly [RegExp, (typeof SALARY_PERIODS)[number]]> = [
  [/(?:\/\s*yr|\/\s*year|per year|a year|yearly|annual|pro jahr|\/\s*jahr|jährlich|p\.\s?a\.)/i, "year"],
  [/(?:\/\s*mo|\/\s*month|per month|a month|monthly|pro monat|\/\s*monat|monatlich)/i, "month"],
  [/(?:\/\s*wk|\/\s*week|per week|weekly|pro woche|\/\s*woche)/i, "week"],
  [/(?:\/\s*day|per day|daily|pro tag|\/\s*tag)/i, "day"],
  [/(?:\/\s*hr|\/\s*hour|per hour|hourly|pro stunde|\/\s*std|\/\s*stunde)/i, "hour"],
];

/** "€70K/yr - €90K/yr", "$120,000.00/yr - $150,000.00/yr", "50.000 € - 70.000 € pro Jahr" -> amounts; null unless amounts, currency and period are all stated (C3). */
export function parseSalaryLine(text: string | null | undefined): ParsedSalary | null {
  const raw = squash(text);
  if (!raw) return null;
  const period = PERIOD_WORDS.find(([pattern]) => pattern.test(raw))?.[1];
  const currencyToken = /(?:€|\$|£|\b(?:EUR|USD|GBP|CHF)\b)/i.exec(raw)?.[0];
  const currency = currencyCodeOf(currencyToken);
  if (period === undefined || currency === null) return null;
  const amounts: number[] = [];
  for (const match of raw.matchAll(/(\d{1,3}(?:[.,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*([kK])?/g)) {
    const numeric = normaliseNumber(match[1] ?? "");
    if (numeric === null) continue;
    amounts.push(match[2] ? numeric * 1000 : numeric);
  }
  const [first, second] = amounts;
  if (first === undefined) return null;
  const min = Math.min(first, second ?? first);
  const max = Math.max(first, second ?? first);
  return { min, max, currency, period, raw };
}

/** "120,000.00" / "50.000" / "70.5" -> number: a separator followed by exactly three digits groups thousands, otherwise it is a decimal point. */
function normaliseNumber(token: string): number | null {
  const compact = token.replace(/[  ]/g, "");
  const grouped = /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(compact);
  let normalised = compact;
  if (grouped) {
    const lastSeparator = Math.max(compact.lastIndexOf("."), compact.lastIndexOf(","));
    const tail = compact.slice(lastSeparator + 1);
    normalised = tail.length === 3 ? compact.replace(/[.,]/g, "") : `${compact.slice(0, lastSeparator).replace(/[.,]/g, "")}.${tail}`;
  } else {
    normalised = compact.replace(",", ".");
  }
  const value = Number(normalised);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
