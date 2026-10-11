import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import { relativeTimeToDate, squash } from "./text";

/** One card of a LinkedIn job list (search results or "recommended for you"). Every field but the id may be missing. */
export interface ListCard {
  jobId: string;
  title: string | null;
  companyName: string | null;
  location: string | null;
  postedAt: Date | null;
  postedText: string | null;
  promoted: boolean;
  easyApply: boolean;
}

const JOB_ID = /^\d{6,}$/;
const URN_ID = /jobPosting:(\d{6,})/;
const HREF_ID = /\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/;

/** Selectors of one card, from the logged-in list to the guest markup (kept as a fallback). */
const CARD_SELECTORS = ["li[data-occludable-job-id]", "div.job-card-container[data-job-id]", "li.jobs-search-results__list-item", "div.base-card[data-entity-urn]", "div.base-search-card[data-entity-urn]", "li:has(div.base-card)"];

const TITLE_SELECTORS = [
  "a.job-card-list__title--link strong",
  "a.job-card-container__link strong",
  "a.job-card-list__title--link",
  "a.job-card-container__link",
  ".base-search-card__title",
  ".job-card-list__title",
  "a[href*='/jobs/view/'] strong",
  "a[href*='/jobs/view/']",
];
const COMPANY_SELECTORS = [".artdeco-entity-lockup__subtitle", ".job-card-container__primary-description", ".job-card-container__company-name", ".base-search-card__subtitle"];
const LOCATION_SELECTORS = [".job-card-container__metadata-item", ".artdeco-entity-lockup__caption li", ".job-card-container__metadata-wrapper li", ".artdeco-entity-lockup__caption", ".job-search-card__location"];

const PROMOTED = /^(?:promoted|anzeige|gesponsert)$/i;
const EASY_APPLY = /^(?:easy apply|einfach bewerben|schnellbewerbung|schnelle bewerbung)$/i;

function firstText($card: cheerio.Cheerio<AnyNode>, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const element = $card.find(selector).first();
    // the visible title is repeated in a visually hidden span: the text of the first element is enough
    const text = squash(element.first().text());
    if (text) return text;
  }
  return null;
}

/** The id one card element stands for: the occludable / data id, an entity urn, or the id in its job link. */
function cardId($card: cheerio.Cheerio<AnyNode>): string | null {
  const direct = $card.attr("data-occludable-job-id");
  if (direct && JOB_ID.test(direct.trim())) return direct.trim();
  const candidates = [$card.attr("data-job-id"), $card.attr("data-entity-urn"), $card.find("[data-job-id]").first().attr("data-job-id"), $card.find("[data-entity-urn]").first().attr("data-entity-urn")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const urn = URN_ID.exec(candidate)?.[1];
    if (urn) return urn;
    if (JOB_ID.test(candidate.trim())) return candidate.trim();
  }
  for (const link of $card.find("a[href*='/jobs/view/']").toArray()) {
    const href = link.attribs.href ?? "";
    const match = HREF_ID.exec(href.split("?")[0] ?? "");
    if (match?.[1]) return match[1];
  }
  return null;
}

/** "Berlin, Berlin, Germany (Hybrid)" -> the work-mode suffix is not part of the place. */
export function stripWorkModeSuffix(location: string | null): { place: string | null; mode: string | null } {
  if (location === null) return { place: null, mode: null };
  const match = /^(.*?)\s*\((remote|hybrid|on-?site|vor ort|homeoffice|home office|remote work)\)\s*$/i.exec(location);
  if (!match) return { place: location, mode: null };
  return { place: squash(match[1]), mode: match[2] ?? null };
}

/**
 * The cards of a LinkedIn job list page, in page order, one per job id. Pure over the page HTML: the browser only delivers the
 * HTML (after scrolling the list so its lazily rendered cards exist). The parser is deliberately forgiving: it keeps a card
 * as long as it has a job id; the posting's page supplies what the card lacks.
 */
export function parseListCards(html: string, now: Date): ListCard[] {
  const $ = cheerio.load(html);
  const cards: ListCard[] = [];
  const seen = new Set<string>();
  const add = ($card: cheerio.Cheerio<AnyNode>): void => {
    const jobId = cardId($card);
    if (jobId === null || seen.has(jobId)) return;
    seen.add(jobId);
    const time = $card.find("time").first();
    const postedText = squash(time.text()) ?? null;
    const datetime = time.attr("datetime");
    const parsedDatetime = datetime && Number.isFinite(Date.parse(datetime)) ? new Date(datetime) : null;
    const footerTexts = $card
      .find("li, span, div")
      .toArray()
      .map((el) => squash($(el).children().length === 0 ? $(el).text() : null))
      .filter((text): text is string => text !== null);
    cards.push({
      jobId,
      title: firstText($card, TITLE_SELECTORS),
      companyName: firstText($card, COMPANY_SELECTORS),
      location: firstText($card, LOCATION_SELECTORS),
      postedAt: parsedDatetime ?? relativeTimeToDate(postedText, now),
      postedText,
      promoted: footerTexts.some((text) => PROMOTED.test(text)),
      easyApply: footerTexts.some((text) => EASY_APPLY.test(text)),
    });
  };
  for (const selector of CARD_SELECTORS) {
    $(selector).each((_, el) => add($(el)));
  }
  if (cards.length === 0) {
    // layout fallback: any job link on the page
    $("a[href*='/jobs/view/']").each((_, el) => add($(el).parent()));
  }
  return cards;
}

const EMPTY_RESULTS = /(?:no matching jobs found|we couldn(?:'|’)t find a match|keine passenden jobs|keine jobs gefunden|keine stellen gefunden|no jobs found)/i;

/** True when the page is LinkedIn's "no results" page (so an empty card list is an answer, not a layout change). */
export function isEmptyResultsPage(html: string): boolean {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  return EMPTY_RESULTS.test($("body").text().replace(/\s+/g, " "));
}
