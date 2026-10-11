import { canonicalUrl, findCards, loadHtml, type JobLink } from "../html";
import { jobFromCard } from "../card";
import type { AlertParser } from "../types";

/** `…/stellenangebote--Titel--<id>-inline.html` (also `-sheet`, `-listing`). */
const ID_IN_PATH = /--(\d{6,})-(?:inline|sheet|listing)?\.html/i;
const JOB_PATH = /\/(?:stellenangebote|jobs?|job-offers?)\b/i;

function matchLink(url: URL): JobLink | null {
  if (!/(^|\.)stepstone\.[a-z.]+$/i.test(url.hostname)) return null;
  const id = ID_IN_PATH.exec(url.pathname)?.[1] ?? null;
  if (id) {
    const clean = new URL(url.toString());
    clean.search = "";
    clean.hash = "";
    return { key: `ss:${id}`, id, url: canonicalUrl(clean) };
  }
  // a job link whose id is not in the path: the cleaned link identifies it
  if (JOB_PATH.test(url.pathname) && /-\d{6,}(?:\.html)?$|--/.test(url.pathname)) {
    const clean = canonicalUrl(url);
    return { key: clean, id: null, url: clean };
  }
  return null;
}

const NOISE: readonly RegExp[] = [
  /^(?:neu|new|top-job|top job|anzeige|gesponsert|sponsored|jetzt bewerben|schnelle bewerbung|job ansehen|zum job|alle jobs ansehen|mehr jobs|abmelden)$/i,
  /^(?:heute|gestern|vor \d+ (?:minuten?|stunden?|tag(?:e|en)?|wochen?|monat(?:e|en)?)(?: ver[öo]ffentlicht)?|ver[öo]ffentlicht .*)$/i,
  /^(?:\d+ (?:minutes?|hours?|days?|weeks?) ago|today|yesterday)$/i,
  /^homeoffice m[öo]glich$/i,
];

export const stepstoneParser: AlertParser = {
  platform: "stepstone",
  parse(html) {
    const $ = loadHtml(html);
    return findCards($, matchLink).map((card) => jobFromCard(card, { noise: NOISE }));
  },
};
