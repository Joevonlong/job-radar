import * as cheerio from "cheerio";

/**
 * Recognise the pages LinkedIn shows instead of content: the login wall (the session is gone) and verification pages
 * (checkpoint, CAPTCHA, "security check", an access denial). The channels STOP on all of them and raise the alarm. Nothing here
 * (or anywhere in this feature) submits a form, clicks, or tries to get past a verification: a human does that, in a normal browser.
 */

export type PageVerdict =
  | { kind: "ok" }
  /** The session is not accepted: LinkedIn sent us to a sign-in page / auth wall. */
  | { kind: "login_required"; reason: string }
  /** A verification page: checkpoint, CAPTCHA, security check, restricted account. */
  | { kind: "checkpoint"; reason: string }
  /** LinkedIn denied or throttled the request (HTTP 999 / 403 / 429). */
  | { kind: "denied"; status: number }
  /** The job is gone (HTTP 404 or LinkedIn's "no longer available" page). */
  | { kind: "unavailable" };

export interface PageSnapshot {
  /** HTTP status of the navigation, null when unknown. */
  status: number | null;
  /** The URL after redirects. */
  url: string;
  html: string;
}

/** HTTP status LinkedIn answers bots with. */
const LINKEDIN_DENIED_STATUS = 999;

const LOGIN_PATH = /^\/(?:login|uas\/login|uas\/request-password-reset|authwall|signup)(?:[/?#]|$)/i;
const CHECKPOINT_PATH = /^\/(?:checkpoint|uas\/captcha|uas\/consumer-captcha|challenge)(?:[/?#]|$)/i;

/** Text that only a verification page carries (English and German UI), matched on the visible text of pages without job content. */
const CHALLENGE_TEXT =
  /(?:quick security check|security verification|let'?s do a quick security check|verify (?:that )?you(?:'|’)?re (?:not )?a (?:robot|human)|are you a robot|unusual activity|we(?:'|’)ve restricted your account|your account has been restricted|sicherheitsüberprüfung|sicherheitsprüfung|kurze sicherheitsüberprüfung|ungewöhnliche aktivität|dein konto wurde eingeschränkt|ihr konto wurde eingeschränkt)/i;

const LOGIN_TEXT = /(?:sign in to view|join linkedin|sign in to continue|anmelden, um|jetzt anmelden und|melde dich an, um)/i;

/** Selectors of pages that carry job content: a page that has one is not a wall, whatever else its text says. */
const CONTENT_SELECTORS = [
  "li[data-occludable-job-id]",
  "[data-job-id]",
  "[data-entity-urn*='jobPosting']",
  "#job-details",
  ".jobs-description__content",
  ".jobs-description",
  ".show-more-less-html__markup",
  ".job-details-jobs-unified-top-card__job-title",
  ".top-card-layout__title",
  ".scaffold-layout__list",
  ".jobs-search-results-list",
];

/** Text of LinkedIn's "this job is gone" page and of a closed job. */
const UNAVAILABLE_TEXT = /(?:this job is no longer available|job (?:is )?no longer available|diese stelle ist nicht mehr verfügbar|dieser job ist nicht mehr verfügbar|diese stellenanzeige ist nicht mehr verfügbar)/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function hasJobContent($: cheerio.CheerioAPI): boolean {
  if ($("script[type='application/ld+json']").toArray().some((el) => /"@type"\s*:\s*"JobPosting"/.test($(el).text()))) return true;
  return CONTENT_SELECTORS.some((selector) => $(selector).length > 0);
}

/**
 * Judge a loaded page. Order: the URL (a redirect to a login / checkpoint path is decisive), the status, then — only
 * for a page without job content — its text. A job description that happens to mention "security check" never trips it.
 */
export function classifyPage(page: PageSnapshot): PageVerdict {
  const pathname = pathOf(page.url);
  if (CHECKPOINT_PATH.test(pathname)) return { kind: "checkpoint", reason: "redirected to a verification page" };
  if (LOGIN_PATH.test(pathname)) return { kind: "login_required", reason: "redirected to the sign-in page" };

  if (page.status === LINKEDIN_DENIED_STATUS || page.status === 403 || page.status === 429) return { kind: "denied", status: page.status };
  if (page.status === 404 || page.status === 410) return { kind: "unavailable" };
  if (page.status === 401) return { kind: "login_required", reason: "HTTP 401" };

  const $ = cheerio.load(page.html);
  if (hasJobContent($)) return { kind: "ok" };

  // no job content: look at what the page says
  $("script, style, noscript").remove();
  const text = $("body").text().replace(/\s+/g, " ");
  if ($("input[name='session_key'], input[name='session_password'], form.login__form, form[action*='login-submit']").length > 0) {
    return { kind: "login_required", reason: "sign-in form" };
  }
  if ($("iframe[src*='captcha'], iframe[src*='recaptcha'], [class*='captcha'], [id*='captcha'], [data-sitekey]").length > 0 || CHALLENGE_TEXT.test(text)) {
    return { kind: "checkpoint", reason: "verification page" };
  }
  if (LOGIN_TEXT.test(text) && $("a[href*='/login']").length > 0) return { kind: "login_required", reason: "auth wall" };
  if (UNAVAILABLE_TEXT.test(text)) return { kind: "unavailable" };
  return { kind: "ok" };
}
