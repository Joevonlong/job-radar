import { canonicalUrl, findCards, loadHtml, type JobLink } from "../html";
import { jobFromCard } from "../card";
import type { AlertParser } from "../types";

/** `https://www.xing.com/jobs/<city>-<title-slug>-<id>`; search and landing pages carry no id. */
const JOB_PATH = /^\/jobs\/(?:[^/?#]*-)?(\d{6,})(?:[/?#]|$)/;

function matchLink(url: URL): JobLink | null {
  if (!/(^|\.)xing\.com$/i.test(url.hostname)) return null;
  const match = JOB_PATH.exec(url.pathname);
  if (!match?.[1]) return null;
  const clean = new URL(url.toString());
  clean.search = "";
  clean.hash = "";
  clean.host = "www.xing.com";
  return { key: match[1], id: match[1], url: canonicalUrl(clean) };
}

const NOISE: readonly RegExp[] = [
  /^(?:neu|new|top-job|top job|anzeige|gesponsert|jetzt bewerben|job ansehen|zum job|schnellbewerbung|alle jobs ansehen|mehr jobs|abbestellen|abmelden)$/i,
  /^(?:heute|gestern|vor \d+ (?:minuten?|stunden?|tag(?:e|en)?|wochen?|monat(?:e|en)?)|ver[öo]ffentlicht .*)$/i,
  /^(?:\d+ (?:minutes?|hours?|days?|weeks?) ago|today|yesterday)$/i,
  /^(?:\d+ kontakte?.*|.*in deinem netzwerk.*|.*in ihrem netzwerk.*)$/i,
];

export const xingParser: AlertParser = {
  platform: "xing",
  parse(html) {
    const $ = loadHtml(html);
    return findCards($, matchLink).map((card) => jobFromCard(card, { noise: NOISE }));
  },
};
