// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseJobDetail, hasJobContent } from "@/lib/channels/linkedin/session/parse-detail";
import { isEmptyResultsPage, parseListCards } from "@/lib/channels/linkedin/session/parse-search";
import { buildPayload, parseSessionPayload, readSessionPayload } from "@/lib/channels/linkedin/session/payload";
import { parseSalaryLine, relativeTimeToDate, htmlFragmentToText } from "@/lib/channels/linkedin/session/text";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { NOW, fixture } from "./helpers";

describe("parseListCards", () => {
  const cards = parseListCards(fixture("search-results.html"), NOW);

  it("reads one card per job id, in page order, and drops the repeated card", () => {
    expect(cards.map((c) => c.jobId)).toEqual(["4385000101", "4385000102", "4385000103", "4385000104", "4385000106"]);
  });

  it("reads title, company, location, time and the Easy Apply / Promoted flags", () => {
    expect(cards[0]).toMatchObject({
      jobId: "4385000101",
      title: "Senior AI Engineer",
      companyName: "Nordlicht Robotics GmbH",
      location: "Berlin, Berlin, Germany (Hybrid)",
      postedText: "2 hours ago",
      easyApply: true,
      promoted: false,
    });
    expect(cards[0]?.postedAt?.toISOString()).toBe("2026-10-07T05:41:00.000Z");
    expect(cards[2]).toMatchObject({ title: "AI Solutions Architect", companyName: "Feldmann Labs", promoted: true, easyApply: false });
  });

  it("takes the id from a slug URL when the data attributes are missing, and a relative time when `datetime` is missing", () => {
    expect(cards[1]?.postedAt?.toISOString()).toBe("2026-10-07T03:00:00.000Z");
    const bare = parseListCards('<ul><li><a href="/jobs/view/ml-engineer-at-acme-4385009999?refId=1">ML Engineer</a></li></ul>', NOW);
    expect(bare.map((c) => c.jobId)).toEqual(["4385009999"]);
  });

  it("keeps a card the list has not rendered yet (only its id) so the posting page can supply the rest", () => {
    expect(cards[4]).toMatchObject({ jobId: "4385000106", title: null, companyName: null });
  });

  it("returns nothing for a page without cards, and recognises the empty-results page", () => {
    expect(parseListCards(fixture("layout-unknown.html"), NOW)).toEqual([]);
    expect(parseListCards(fixture("search-results-empty.html"), NOW)).toEqual([]);
    expect(isEmptyResultsPage(fixture("search-results-empty.html"))).toBe(true);
    expect(isEmptyResultsPage(fixture("layout-unknown.html"))).toBe(false);
  });

  it("parses the recommended list the same way", () => {
    const recommended = parseListCards(fixture("recommended.html"), NOW);
    expect(recommended.map((c) => [c.jobId, c.title])).toEqual([
      ["4385000201", "Forward Deployed Engineer"],
      ["4385000202", "Applied Scientist, NLP"],
      ["4385000103", "AI Solutions Architect"],
    ]);
  });
});

describe("parseJobDetail", () => {
  it("reads the English page: JSON-LD facts, the top card, the pills and the description", () => {
    const detail = parseJobDetail(fixture("job-detail.html"), NOW);
    expect(detail).toMatchObject({
      title: "Senior AI Engineer",
      companyName: "Nordlicht Robotics GmbH",
      companyUrl: "https://www.linkedin.com/company/nordlicht-robotics",
      location: "Berlin, Berlin, DE",
      workplaceText: "Hybrid",
      employmentText: "Full-time",
      salaryText: "€80K/yr - €100K/yr",
      postedText: "Reposted 2 hours ago",
      applicantsText: "Over 100 applicants",
      easyApply: true,
      closed: false,
    });
    expect(detail.postedAt?.toISOString()).toBe("2026-10-07T05:41:00.000Z");
    expect(detail.salary).toMatchObject({ min: 80000, max: 100000, currency: "EUR", period: "year" });
    expect(hasJobContent(detail)).toBe(true);
    expect(htmlFragmentToText(detail.descriptionHtml ?? "")).toContain("- Strong Python and PyTorch");
  });

  it("reads the German page (no JSON-LD): relative time, work mode, salary and applicants in German", () => {
    const detail = parseJobDetail(fixture("job-detail-de.html"), NOW);
    expect(detail).toMatchObject({
      title: "LLM Engineer (m/w/d)",
      companyName: "Kornblum Analytics AG",
      location: "Berlin, Berlin, Deutschland",
      workplaceText: "Vor Ort",
      employmentText: "Vollzeit",
      applicantsText: "Mehr als 100 Bewerber",
      postedText: "vor 3 Tagen",
    });
    expect(detail.postedAt?.toISOString()).toBe("2026-10-04T08:00:00.000Z");
    expect(detail.salary).toMatchObject({ min: 70000, max: 90000, currency: "EUR", period: "year" });
  });

  it("reads a page that only has the JSON-LD (remote, day rate, entity-escaped description)", () => {
    const detail = parseJobDetail(fixture("job-detail-jsonld-only.html"), NOW);
    expect(detail).toMatchObject({ title: "Machine Learning Engineer", companyName: "Sonnenhof Digital", location: "Berlin, DE", workplaceText: "Remote", employmentText: "Contractor" });
    expect(detail.salary).toMatchObject({ min: 600, max: 750, currency: "EUR", period: "day" });
    expect(htmlFragmentToText(detail.descriptionHtml ?? "")).toBe("Train and ship ranking models.\nRemote within the EU.");
  });

  it("flags a job that no longer takes applications, and tells an unknown layout from a page with content", () => {
    expect(parseJobDetail(fixture("job-detail-closed.html"), NOW).closed).toBe(true);
    expect(hasJobContent(parseJobDetail(fixture("layout-unknown.html"), NOW))).toBe(false);
  });
});

describe("payload and draft", () => {
  const detail = parseJobDetail(fixture("job-detail.html"), NOW);
  const card = parseListCards(fixture("search-results.html"), NOW)[0] ?? null;

  it("merges the card and the page into a payload that parses back into a valid draft", () => {
    const payload = buildPayload({ jobId: "4385000101", url: "https://www.linkedin.com/jobs/view/4385000101/", source: "search", card, detail });
    expect(payload).not.toBeNull();
    expect(readSessionPayload(payload)).toMatchObject({ jobId: "4385000101", detailFetched: true });
    const draft = normalizedPostingDraftSchema.parse(parseSessionPayload(payload));
    expect(draft).toMatchObject({
      title: "Senior AI Engineer",
      companyName: "Nordlicht Robotics GmbH",
      workplace: "hybrid",
      contractHint: "Full-time",
      salaryText: "€80K/yr - €100K/yr",
      applyUrl: "https://www.linkedin.com/jobs/view/4385000101/",
      sourceUrl: "https://www.linkedin.com/jobs/view/4385000101/",
    });
    expect(draft.locations[0]).toMatchObject({ city: "Berlin", countryCode: "DE" });
    expect(draft.salary).toMatchObject({ min: 80000, max: 100000, currency: "EUR", period: "year" });
    expect(draft.postedAt?.toISOString()).toBe("2026-10-07T05:41:00.000Z");
    expect(draft.description).toContain("Your mission");
    expect(draft.description).toContain("- Experience shipping models to production");
    expect(draft.extra).toMatchObject({ jobId: "4385000101", applicants: "Over 100 applicants", easyApply: true });
  });

  it("falls back to the card when the page has nothing, with the work mode taken from the card's suffix", () => {
    const payload = buildPayload({ jobId: "4385000101", url: "https://www.linkedin.com/jobs/view/4385000101/", source: "search", card, detail: null });
    const draft = normalizedPostingDraftSchema.parse(parseSessionPayload(payload));
    expect(draft).toMatchObject({ title: "Senior AI Engineer", workplace: "hybrid", description: "" });
    expect(draft.locations[0]?.label).toBe("Berlin, Berlin, Germany");
    expect(payload?.detailFetched).toBe(false);
  });

  it("builds nothing without a title and a company; rejects a payload of the wrong shape", () => {
    const placeholder = parseListCards(fixture("search-results.html"), NOW)[4] ?? null;
    expect(buildPayload({ jobId: "4385000106", url: "https://www.linkedin.com/jobs/view/4385000106/", source: "search", card: placeholder, detail: null })).toBeNull();
    expect(() => parseSessionPayload({ jobId: "x" })).toThrow(/does not match the expected shape/);
    expect(() => parseSessionPayload({ jobId: "4385000101", url: "ftp://x", source: "search", title: "t", companyName: "c" })).toThrow(/no valid url/);
  });
});

describe("text helpers", () => {
  it("turns English and German relative times into moments", () => {
    const at = (text: string) => relativeTimeToDate(text, NOW)?.toISOString();
    expect(at("2 hours ago")).toBe("2026-10-07T06:00:00.000Z");
    expect(at("Reposted 3 days ago")).toBe("2026-10-04T08:00:00.000Z");
    expect(at("1 week ago")).toBe("2026-09-30T08:00:00.000Z");
    expect(at("vor 5 Minuten")).toBe("2026-10-07T07:55:00.000Z");
    expect(at("vor einem Monat")).toBe("2026-09-07T08:00:00.000Z");
    expect(at("just now")).toBe(NOW.toISOString());
    expect(at("gestern")).toBe("2026-10-06T08:00:00.000Z");
    expect(relativeTimeToDate("Easy Apply", NOW)).toBeNull();
    expect(relativeTimeToDate(null, NOW)).toBeNull();
  });

  it("reads salary lines only when amounts, currency and period are all stated", () => {
    expect(parseSalaryLine("€80K/yr - €100K/yr")).toMatchObject({ min: 80000, max: 100000, currency: "EUR", period: "year" });
    expect(parseSalaryLine("$120,000.00/yr - $150,000.00/yr")).toMatchObject({ min: 120000, max: 150000, currency: "USD" });
    expect(parseSalaryLine("70.000 € - 90.000 € pro Jahr")).toMatchObject({ min: 70000, max: 90000, currency: "EUR" });
    expect(parseSalaryLine("€45/hr")).toMatchObject({ min: 45, max: 45, period: "hour" });
    expect(parseSalaryLine("€80K")).toBeNull(); // no period
    expect(parseSalaryLine("80K/yr")).toBeNull(); // no currency
    expect(parseSalaryLine("Competitive")).toBeNull();
  });
});
