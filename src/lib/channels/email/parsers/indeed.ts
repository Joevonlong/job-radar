import { canonicalUrl, findCards, loadHtml, type JobLink } from "../html";
import { jobFromCard } from "../card";
import type { AlertParser } from "../types";

const JOB_PATH = /^\/(?:rc\/clk|viewjob|m\/viewjob|pagead\/clk|company\/[^/]+\/jobs\/|jobs\/view)/i;
const JK = /^[0-9a-f]{12,20}$/i;

function matchLink(url: URL): JobLink | null {
  if (!/(^|\.)indeed\.[a-z.]+$/i.test(url.hostname)) return null;
  if (!JOB_PATH.test(url.pathname)) return null;
  const jk = [url.searchParams.get("jk"), url.searchParams.get("vjk")].find((v): v is string => v !== null && JK.test(v));
  if (jk) {
    const clean = new URL(`https://${url.hostname.replace(/^(?:cts|click|www)\./i, "")}/viewjob`);
    clean.searchParams.set("jk", jk.toLowerCase());
    return { key: jk.toLowerCase(), id: jk.toLowerCase(), url: clean.toString() };
  }
  // sponsored `pagead/clk` links carry no stable id: the cleaned link identifies the job
  const clean = canonicalUrl(url);
  return { key: clean, id: null, url: clean };
}

const NOISE: readonly RegExp[] = [
  /^(?:easily apply|einfach bewerben|apply now|jetzt bewerben|view job|job ansehen|new|neu|urgently hiring|dringend gesucht|responsive employer|antwortet schnell)$/i,
  /^(?:hiring multiple candidates|mehrere kandidaten gesucht|sponsored|gesponsert|see all jobs|alle jobs ansehen|unsubscribe)$/i,
  /^(?:posted|active|veröffentlicht|vor)\b.*\b(?:ago|days?|hours?|tag(?:e|en)?|stunden?|today|heute)\b.*$/i,
  /^(?:just posted|today|heute|gerade veröffentlicht|\d+\+? (?:days?|hours?) ago|vor \d+\+? (?:tag(?:e|en)?|stunden?|wochen?))$/i,
];

export const indeedParser: AlertParser = {
  platform: "indeed",
  parse(html) {
    const $ = loadHtml(html);
    return findCards($, matchLink).map((card) => jobFromCard(card, { noise: NOISE }));
  },
};
