import { extractWorkplace, isSalaryLine, matchesAny, snippetOf, type CardCandidate } from "./html";
import type { AlertJob } from "./types";

/** Prediction / estimate lines are not the posting's salary (C3). */
const SALARY_ESTIMATE = /gehaltsprognose|gehaltssch[äa]tzung|gesch[äa]tzt|estimated|estimate\b|salary insights/i;
/** "4,2 ★", "4.1 stars" company ratings. */
const RATING = /^\d[.,]\d\s*(?:★|☆|stars?|sterne?)?$|^★+/i;
const COMPANY_LOCATION_SEPARATOR = /\s+(?:·|•|\||[-–—])\s+/;
const MAX_LOCATION_CHARS = 90;

function looksLikeLocation(line: string): boolean {
  return line.length <= MAX_LOCATION_CHARS && !/[.!?]$/.test(line) && line.split(/\s+/).length <= 12;
}

export interface CardOptions {
  /** UI chrome and status badges of the platform (never company, location or teaser text). */
  noise: readonly RegExp[];
}

/**
 * The common card layout of the alert emails: below the title come the company, then the location,
 * then optional salary / badge / teaser lines. "Company · Location" in one line is split. Salary
 * estimates and badges are dropped; whatever is left becomes the teaser. Nothing is guessed: a
 * missing line stays null.
 */
export function jobFromCard(card: CardCandidate, options: CardOptions): AlertJob {
  const rest: string[] = [];
  let salaryText: string | null = null;
  for (const line of card.lines) {
    if (matchesAny(line, options.noise) || SALARY_ESTIMATE.test(line) || RATING.test(line)) continue;
    if (salaryText === null && isSalaryLine(line)) {
      salaryText = line;
      continue;
    }
    rest.push(line);
  }

  let company: string | null = null;
  let location: string | null = null;
  const first = rest.shift();
  if (first !== undefined) {
    const split = first.split(COMPANY_LOCATION_SEPARATOR);
    if (split.length === 2 && split[0] && split[1] && looksLikeLocation(split[1])) {
      company = split[0].trim();
      location = split[1].trim();
    } else {
      company = first;
      const second = rest[0];
      if (second !== undefined && looksLikeLocation(second)) {
        location = second;
        rest.shift();
      }
    }
  }

  let workplace = null;
  if (location) {
    const found = extractWorkplace(location);
    workplace = found.workplace;
    location = found.text.length > 0 ? found.text : null;
  }

  return {
    id: card.link.id,
    url: card.link.url,
    title: card.title,
    company,
    location,
    workplace,
    salaryText,
    snippet: snippetOf(rest),
  };
}
