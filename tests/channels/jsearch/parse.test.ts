// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { cleanUrl, rankApplyLinks } from "@/lib/channels/jsearch/apply";
import { parseJsearchPayload, postedAt } from "@/lib/channels/jsearch/parse";
import { jobSchema } from "@/lib/channels/jsearch/schema";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { DETAILS, RECORDS, SEARCH_V2, shippedJsearch } from "./helpers";

const PREFERENCE = shippedJsearch().apply_publisher_preference;
const UTM = "?utm_campaign=google_jobs_apply&utm_source=google_jobs_apply&utm_medium=organic";

function parse(search: unknown, detail: unknown = null) {
  return normalizedPostingDraftSchema.parse(parseJsearchPayload({ search, detail }, PREFERENCE));
}

describe("cleanUrl", () => {
  it("drops tracking parameters, keeps the rest, and rejects non-http links", () => {
    expect(cleanUrl(`https://example.com/jobs/1${UTM}`)).toBe("https://example.com/jobs/1");
    expect(cleanUrl("https://example.com/jobs?jid=abc&utm_source=x&gclid=1")).toBe("https://example.com/jobs?jid=abc");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("not a url")).toBeNull();
    expect(cleanUrl(null)).toBeNull();
  });
});

describe("rankApplyLinks (plan 5.1: company site before job boards before aggregators)", () => {
  const job = (overrides: Record<string, unknown>) =>
    jobSchema.parse({ job_id: "x", job_title: "t", employer_name: "e", employer_website: "https://acme.example", job_publisher: "BeBee", ...overrides });
  const option = (publisher: string, link: string, isDirect = false) => ({ publisher, apply_link: link, is_direct: isDirect });

  it("puts a link the API flags as direct first, whatever its position", () => {
    const links = rankApplyLinks(
      job({
        job_apply_link: "https://bebee.example/1",
        apply_options: [option("BeBee", "https://bebee.example/1"), option("LinkedIn", "https://www.linkedin.com/jobs/view/1"), option("Acme Careers", "https://jobs.acme-careers.example/1", true)],
      }),
      PREFERENCE,
    );
    expect(links.map((l) => [l.publisher, l.direct])).toEqual([
      ["Acme Careers", true],
      ["LinkedIn", false],
      ["BeBee", false],
    ]);
    expect(links[0]?.url).toBe("https://jobs.acme-careers.example/1");
  });

  it("recognises the employer's own site (sub-domains included) and official ATS boards as direct", () => {
    const links = rankApplyLinks(
      job({
        job_apply_link: "https://bebee.example/1",
        apply_options: [option("BeBee", "https://bebee.example/1"), option("Lever", "https://jobs.lever.co/acme/123"), option("Acme", "https://careers.acme.example/x")],
      }),
      PREFERENCE,
    );
    expect(links.map((l) => [l.url, l.direct])).toEqual([
      ["https://jobs.lever.co/acme/123", true],
      ["https://careers.acme.example/x", true],
      ["https://bebee.example/1", false],
    ]);
  });

  it("orders the other links by the configured publisher preference; unknown publishers come last, API order breaks ties", () => {
    const links = rankApplyLinks(
      job({
        job_apply_link: "https://bebee.example/1",
        apply_options: [
          option("BeBee", "https://bebee.example/1"),
          option("Jobrapido", "https://jobrapido.example/1"),
          option("Indeed", "https://de.indeed.com/viewjob?jk=1"),
          option("StepStone", "https://www.stepstone.de/job/1"),
          option("LinkedIn", "https://www.linkedin.com/jobs/view/1"),
        ],
      }),
      PREFERENCE,
    );
    expect(links.map((l) => l.publisher)).toEqual(["LinkedIn", "StepStone", "Indeed", "BeBee", "Jobrapido"]);
    expect(rankApplyLinks(job({ job_apply_link: "https://bebee.example/1", apply_options: [option("LinkedIn", "https://www.linkedin.com/jobs/view/1"), option("BeBee", "https://bebee.example/1")] }), []).map((l) => l.publisher)).toEqual([
      "BeBee",
      "LinkedIn",
    ]);
  });

  it("lists the primary link once and ignores links that are not http(s)", () => {
    const links = rankApplyLinks(job({ job_apply_link: `https://bebee.example/1${UTM}`, apply_options: [option("BeBee", "https://bebee.example/1"), option("Broken", "ftp://x.example/1")] }), PREFERENCE);
    expect(links).toHaveLength(1);
  });
});

describe("parseJsearchPayload", () => {
  const [direct, aggregator, noDescription, broken] = RECORDS;

  it("maps a company-careers posting: apply link, structured salary, location, time, contract", () => {
    const draft = parse(direct);
    expect(draft).toMatchObject({
      title: "Senior AI Engineer (m/w/d)",
      companyName: "Beispiel Robotics GmbH",
      workplace: "unknown", // job_is_remote:false only says "not fully remote"
      contractHint: "full-time",
      salaryText: "€80K–€110K a year",
      salary: { min: 80000, max: 110000, currency: "EUR", period: "year" },
      applyUrl: "https://careers.beispiel-robotics.example/jobs/senior-ai-engineer",
      sourceUrl: "https://careers.beispiel-robotics.example/jobs/senior-ai-engineer",
    });
    expect(draft.locations).toEqual([{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE" }]);
    expect(draft.postedAt?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
    expect(draft.description).toContain("LLM-Pipelines");
    expect(draft.extra).toMatchObject({ publisher: "Beispiel Robotics Careers", applyIsDirect: true, applyPublisher: "Beispiel Robotics Careers" });
  });

  it("an aggregator-only remote posting applies through LinkedIn, then StepStone, and keeps its listing page as source", () => {
    const draft = parse(aggregator);
    expect(draft.workplace).toBe("remote");
    expect(draft.contractHint).toBe("full-time, contract");
    expect(draft.applyUrl).toBe("https://de.linkedin.com/jobs/view/llm-engineer-remote-9876543210");
    expect(draft.sourceUrl).toBe("https://bebee.example/jobs/llm-engineer-remote-eu-abc");
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBeNull();
    expect(draft.locations).toEqual([{ label: "Germany", city: null, countryCode: "DE" }]);
    // no datetime: the Unix timestamp is used
    expect(draft.postedAt?.getTime()).toBe(1791158400 * 1000);
    expect(draft.extra).toMatchObject({ applyIsDirect: false, applyPublisher: "LinkedIn", applyLinks: 4 });
  });

  it("keeps a salary without a stated currency as text only (no guessing), and an hourly period", () => {
    const draft = parse(noDescription);
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBe("45-60/hour");
    expect(draft.description).toBe("");
    expect(draft.contractHint).toBeNull();
    expect(draft.workplace).toBe("unknown");
  });

  it("the details record fills what the search left out", () => {
    const detail = (DETAILS.data as unknown[])[0];
    const draft = parse(noDescription, detail);
    expect(draft.description).toContain("Tafel AI baut Agenten");
    expect(draft.title).toBe("Applied AI Engineer");
  });

  it("uses job_salary_currency when the API sends it", () => {
    const draft = parse({ ...direct, job_salary_string: "80K-110K a year", job_salary_currency: "chf" });
    expect(draft.salary).toMatchObject({ currency: "CHF", min: 80000, max: 110000 });
  });

  it("drops a salary whose bounds are reversed but keeps the text", () => {
    const draft = parse({ ...direct, job_min_salary: 120000, job_max_salary: 90000 });
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBe("€80K–€110K a year");
  });

  it("takes the AI-enriched work arrangement over job_is_remote", () => {
    expect(parse({ ...direct, work_arrangement: "hybrid" }).workplace).toBe("hybrid");
    expect(parse({ ...aggregator, work_arrangement: "onsite" }).workplace).toBe("onsite");
  });

  it("parses the record published on the vendor's product page", () => {
    const sample = ((SEARCH_V2.data as { jobs: unknown[] }).jobs)[0];
    const draft = parse(sample);
    expect(draft).toMatchObject({
      title: "Solutions Engineer - (API & Payments Infrastructure)",
      companyName: "Tafel Payments",
      workplace: "hybrid",
      seniorityHint: "mid",
      salaryText: "150K–280K a year",
      salary: null, // no currency anywhere in the record
      applyUrl: expect.stringContaining("https://www.linkedin.com/jobs/view/solutions-engineer"),
    });
    expect(draft.applyUrl).not.toContain("utm_");
    expect(draft.locations[0]).toMatchObject({ city: "Chicago", countryCode: "US" });
    expect(draft.postedAt?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("rejects payloads without a title, an employer, or the expected shape", () => {
    expect(() => parseJsearchPayload({ search: broken, detail: null }, PREFERENCE)).toThrow(ChannelError);
    expect(() => parseJsearchPayload({ search: { ...direct, employer_name: " " }, detail: null }, PREFERENCE)).toThrow(/employer/);
    expect(() => parseJsearchPayload({ search: { job_title: "x" } }, PREFERENCE)).toThrow(/expected shape/);
    expect(() => parseJsearchPayload("nope", PREFERENCE)).toThrow(ChannelError);
  });

  it("postedAt ignores unusable values", () => {
    expect(postedAt({ job_posted_at_datetime_utc: "garbage", job_posted_at_timestamp: null })).toBeNull();
    expect(postedAt({ job_posted_at_datetime_utc: null, job_posted_at_timestamp: 0 })).toBeNull();
  });
});
