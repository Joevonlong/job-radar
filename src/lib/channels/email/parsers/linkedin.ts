import { canonicalUrl, findCards, loadHtml, type JobLink } from "../html";
import { jobFromCard } from "../card";
import type { AlertParser } from "../types";

const JOB_PATH = /\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/;

/** Job links of LinkedIn alert emails: `/jobs/view/<id>`, `/comm/jobs/view/<id>`, slug form, possibly wrapped in `/e/v2?...&url=`. */
function matchLink(url: URL): JobLink | null {
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const id = JOB_PATH.exec(url.pathname)?.[1];
  if (!id) return null;
  return { key: id, id, url: canonicalUrl(new URL(`https://www.linkedin.com/jobs/view/${id}/`)) };
}

const NOISE: readonly RegExp[] = [
  /^(?:view job|apply(?: now)?|easy apply|see all jobs|view all jobs|view more jobs|unsubscribe)$/i,
  /^(?:actively (?:recruiting|hiring)|be an early applicant|promoted|new|top applicant|reposted.*|hiring in your network)$/i,
  /^(?:\d+|one) (?:connections?|school alumni|alumni|applicants?|people clicked apply)\b.*$/i,
  /^.*\b(?:school alumni|in your network|works? here|connections? work)\b.*$/i,
  /^(?:\d+|an?) (?:minutes?|hours?|days?|weeks?|months?) ago$/i,
  /^just now$/i,
  /^(?:stellenangebot ansehen|jetzt bewerben|schnelle bewerbung|aktive rekrutierung|neu|anzeige|alle jobs anzeigen)$/i,
  /^vor \d+ (?:minuten?|stunden?|tag(?:e|en)?|wochen?|monat(?:e|en)?)$/i,
];

export const linkedinParser: AlertParser = {
  platform: "linkedin",
  parse(html) {
    const $ = loadHtml(html);
    return findCards($, matchLink).map((card) => jobFromCard(card, { noise: NOISE }));
  },
};
