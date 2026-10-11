import * as cheerio from "cheerio";
import { z } from "zod";

import { relativeTimeToDate, squash, type ParsedSalary, parseSalaryLine } from "./text";

/**
 * What a LinkedIn job page (`/jobs/view/<id>/`, logged in) shows. Read from the page's JSON-LD `JobPosting` first (stable, and
 * present on LinkedIn's job pages) and from the visible markup for what the JSON-LD lacks (work mode, applicant count,
 * the salary pill). Every field may be missing; the caller decides what is enough. Pure over the HTML.
 */
export interface JobDetail {
  title: string | null;
  companyName: string | null;
  companyUrl: string | null;
  location: string | null;
  /** The work mode as LinkedIn words it ("Remote", "Hybrid", "On-site", "Vor Ort"). */
  workplaceText: string | null;
  employmentText: string | null;
  seniorityText: string | null;
  salaryText: string | null;
  salary: ParsedSalary | null;
  /** The description's HTML (kept so a better parser can re-read it later). */
  descriptionHtml: string | null;
  postedAt: Date | null;
  postedText: string | null;
  applicantsText: string | null;
  easyApply: boolean;
  /** LinkedIn says the job no longer takes applications. */
  closed: boolean;
}

const jsonLdPosting = z.looseObject({
  "@type": z.union([z.string(), z.array(z.string())]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  datePosted: z.string().optional(),
  employmentType: z.union([z.string(), z.array(z.string())]).optional(),
  jobLocationType: z.string().optional(),
  hiringOrganization: z.looseObject({ name: z.string().optional(), sameAs: z.string().optional(), url: z.string().optional() }).optional(),
  jobLocation: z
    .union([
      z.looseObject({ address: z.looseObject({ addressLocality: z.string().optional(), addressRegion: z.string().optional(), addressCountry: z.union([z.string(), z.looseObject({ name: z.string().optional() })]).optional() }).optional() }),
      z.array(z.unknown()),
    ])
    .optional(),
  baseSalary: z
    .looseObject({
      currency: z.string().optional(),
      value: z.looseObject({ minValue: z.number().optional(), maxValue: z.number().optional(), value: z.number().optional(), unitText: z.string().optional() }).optional(),
    })
    .optional(),
});
type JsonLdPosting = z.infer<typeof jsonLdPosting>;

function isJobPosting(value: unknown): value is JsonLdPosting {
  const parsed = jsonLdPosting.safeParse(value);
  if (!parsed.success) return false;
  const type = parsed.data["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

/** The JobPosting object of the page's JSON-LD blocks (a block may be an object, an array, or a `@graph`). */
function findJsonLdPosting($: cheerio.CheerioAPI): JsonLdPosting | null {
  for (const el of $("script[type='application/ld+json']").toArray()) {
    let data: unknown;
    try {
      data = JSON.parse($(el).text());
    } catch {
      continue;
    }
    const queue: unknown[] = [data];
    while (queue.length > 0) {
      const item = queue.shift();
      if (Array.isArray(item)) queue.push(...item);
      else if (typeof item === "object" && item !== null) {
        if (isJobPosting(item)) return item;
        const graph = (item as { "@graph"?: unknown })["@graph"];
        if (Array.isArray(graph)) queue.push(...graph);
      }
    }
  }
  return null;
}

const TITLE_SELECTORS = [".job-details-jobs-unified-top-card__job-title h1", ".job-details-jobs-unified-top-card__job-title", "h1.top-card-layout__title", ".top-card-layout__title", "h1.t-24", "h1"];
const COMPANY_SELECTORS = [".job-details-jobs-unified-top-card__company-name a", ".job-details-jobs-unified-top-card__company-name", "a.topcard__org-name-link", ".topcard__org-name-link", ".top-card-layout__card a[href*='/company/']"];
const DESCRIPTION_SELECTORS = ["#job-details", ".jobs-description__content .jobs-box__html-content", ".jobs-description-content__text", ".jobs-description__content", ".show-more-less-html__markup", ".description__text .show-more-less-html"];
const PRIMARY_DESCRIPTION_SELECTORS = [".job-details-jobs-unified-top-card__primary-description-container", ".job-details-jobs-unified-top-card__primary-description", ".top-card-layout__second-subline", ".topcard__flavor-row"];
const PILL_SELECTORS = [".job-details-fit-level-preferences button", ".job-details-preferences-and-skills__pill", ".job-details-fit-level-preferences li", ".job-details-jobs-unified-top-card__job-insight span"];

const WORKPLACE = /^(?:remote|hybrid|on-?site|vor ort|homeoffice|home office|präsenz)$/i;
const EMPLOYMENT = /^(?:full-?time|part-?time|contract|temporary|internship|volunteer|vollzeit|teilzeit|befristet|praktikum|werkstudent|freelance|freiberuflich|other)$/i;
const SENIORITY = /^(?:internship|entry level|associate|mid-senior level|director|executive|not applicable|berufseinsteiger|mit berufserfahrung|mid-senior|führungskraft|direktor)$/i;
const POSTED = /(?:\bago\b|\bvor \d|reposted|wiedereingestellt|just now|gerade eben|\bposted\b|veröffentlicht)/i;
const APPLICANTS = /(?:applicants?|bewerber|clicked apply|people clicked|personen haben|haben sich beworben)/i;
const CLOSED = /(?:no longer accepting applications|not accepting applications|nimmt keine bewerbungen mehr an|werden keine bewerbungen mehr angenommen)/i;
const SALARY_PILL = /[\d].*(?:€|\$|£|EUR|USD|GBP|CHF)|(?:€|\$|£|EUR|USD|GBP|CHF).*\d/;

function firstText($: cheerio.CheerioAPI, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const text = squash($(selector).first().text());
    if (text) return text;
  }
  return null;
}

function employmentFromJsonLd(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) return null;
  return first.replace(/_/g, "-").toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

function locationFromJsonLd(posting: JsonLdPosting | null): string | null {
  const jobLocation = posting?.jobLocation;
  if (!jobLocation || Array.isArray(jobLocation)) return null;
  const address = jobLocation.address;
  if (!address) return null;
  const country = typeof address.addressCountry === "string" ? address.addressCountry : address.addressCountry?.name;
  const parts = [address.addressLocality, address.addressRegion, country].map((p) => squash(p)).filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

function salaryFromJsonLd(posting: JsonLdPosting | null): { text: string; salary: ParsedSalary } | null {
  const base = posting?.baseSalary;
  const value = base?.value;
  if (!base?.currency || !value?.unitText) return null;
  const period = /year|jahr|annual/i.test(value.unitText) ? "year" : /month|monat/i.test(value.unitText) ? "month" : /week|woche/i.test(value.unitText) ? "week" : /day|tag/i.test(value.unitText) ? "day" : /hour|stunde/i.test(value.unitText) ? "hour" : null;
  const min = value.minValue ?? value.value ?? null;
  const max = value.maxValue ?? value.value ?? null;
  if (period === null || (min === null && max === null) || !/^[A-Z]{3}$/.test(base.currency)) return null;
  const text = `${min ?? ""}-${max ?? ""} ${base.currency}/${period}`;
  return { text, salary: { min, max, currency: base.currency, period, raw: text } };
}

/** The visible description element (largest candidate) as HTML, or null. */
function descriptionHtmlOf($: cheerio.CheerioAPI, posting: JsonLdPosting | null): string | null {
  for (const selector of DESCRIPTION_SELECTORS) {
    const element = $(selector).first();
    const html = element.html()?.trim();
    if (html && squash(element.text())) return html;
  }
  const fromJsonLd = posting?.description?.trim();
  if (!fromJsonLd) return null;
  // some JSON-LD descriptions carry the markup entity-escaped ("&lt;br&gt;"): decode it once so it is markup again
  return !fromJsonLd.includes("<") && fromJsonLd.includes("&lt;") ? cheerio.load(`<div>${fromJsonLd}</div>`).text() : fromJsonLd;
}

/** Parse one job page. `now` anchors relative times ("Reposted 2 hours ago"). */
export function parseJobDetail(html: string, now: Date): JobDetail {
  const $ = cheerio.load(html);
  const posting = findJsonLdPosting($);

  const primary = firstText($, PRIMARY_DESCRIPTION_SELECTORS);
  const segments = primary ? primary.split(/\s*[·•|]\s*/).map((s) => s.trim()).filter((s) => s !== "") : [];
  const postedText = segments.find((s) => POSTED.test(s)) ?? null;
  const applicantsText = segments.find((s) => APPLICANTS.test(s)) ?? squash($("figcaption.num-applicants__caption, .num-applicants__caption").first().text());
  const domLocation = segments.find((s) => !POSTED.test(s) && !APPLICANTS.test(s)) ?? squash($(".topcard__flavor--bullet").first().text());

  const pills = PILL_SELECTORS.flatMap((selector) => $(selector).toArray().map((el) => squash($(el).text()))).filter((t): t is string => t !== null);
  const pillText = (pattern: RegExp): string | null => pills.find((pill) => pattern.test(pill)) ?? null;
  const criteria = new Map<string, string>();
  $("li.description__job-criteria-item").each((_, el) => {
    const label = squash($(el).find(".description__job-criteria-subheader").text());
    const value = squash($(el).find(".description__job-criteria-text").text());
    if (label && value) criteria.set(label.toLowerCase(), value);
  });
  const criterion = (...labels: string[]): string | null => labels.map((l) => criteria.get(l)).find((v) => v !== undefined) ?? null;

  const jsonSalary = salaryFromJsonLd(posting);
  const salaryPill = pills.find((pill) => SALARY_PILL.test(pill)) ?? null;
  const salaryText = salaryPill ?? jsonSalary?.text ?? null;

  const company = posting?.hiringOrganization;
  const companyAnchor = $(COMPANY_SELECTORS.join(", ")).filter("a").first();
  const postedIso = posting?.datePosted && Number.isFinite(Date.parse(posting.datePosted)) ? new Date(posting.datePosted) : null;
  // only the top card and feedback banners: a description that talks about applications must not close the job
  const bannerText = squash($(".job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, .top-card-layout, .closed-job, .artdeco-inline-feedback").text()) ?? "";

  return {
    title: squash(posting?.title) ?? firstText($, TITLE_SELECTORS),
    companyName: squash(company?.name) ?? firstText($, COMPANY_SELECTORS),
    companyUrl: squash(company?.sameAs) ?? squash(company?.url) ?? squash(companyAnchor.attr("href")),
    location: locationFromJsonLd(posting) ?? domLocation,
    workplaceText: pillText(WORKPLACE) ?? (posting?.jobLocationType === "TELECOMMUTE" ? "Remote" : null),
    employmentText: pillText(EMPLOYMENT) ?? criterion("employment type", "beschäftigungsverhältnis") ?? employmentFromJsonLd(posting?.employmentType),
    seniorityText: pillText(SENIORITY) ?? criterion("seniority level", "karrierestufe"),
    salaryText,
    salary: jsonSalary?.salary ?? parseSalaryLine(salaryText),
    descriptionHtml: descriptionHtmlOf($, posting),
    postedAt: postedIso ?? relativeTimeToDate(postedText, now),
    postedText,
    applicantsText,
    easyApply: $("button.jobs-apply-button, .jobs-apply-button--top-card, [aria-label*='Easy Apply'], [aria-label*='Einfach bewerben']").length > 0,
    closed: CLOSED.test(bannerText),
  };
}

/** Whether the job page has anything to read (a title); a page without one is a layout we do not know. */
export function hasJobContent(detail: JobDetail): boolean {
  return detail.title !== null && detail.companyName !== null;
}
