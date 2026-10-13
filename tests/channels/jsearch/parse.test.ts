// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { cleanUrl, rankApplyLinks } from "@/lib/channels/jsearch/apply";
import { parseJsearchPayload, postedAt } from "@/lib/channels/jsearch/parse";
import { jobSchema } from "@/lib/channels/jsearch/schema";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";
import { normalizeDraft } from "@/lib/pipeline";

import { shippedPipeline } from "../../pipeline/helpers";
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

describe("a stored detail (detail_source: stored) provides the description only", () => {
  const OLD_DESCRIPTION = "Description stored weeks ago.";
  const search = {
    job_id: "x",
    job_title: "Platform Engineer",
    employer_name: "Acme GmbH",
    job_city: "Hamburg",
    job_location: null,
    job_country: "DE",
    job_min_salary: 110000,
    job_max_salary: 120000,
    job_salary_currency: "EUR",
    job_salary_period: "YEAR",
    job_salary_string: null,
    job_apply_link: "https://jobs.acme.example/new",
    job_posted_at_datetime_utc: "2026-10-06T00:00:00.000Z",
  };
  const detail = {
    job_id: "x",
    job_title: "Platform Engineer",
    employer_name: "Acme GmbH",
    job_description: OLD_DESCRIPTION,
    job_location: "Berlin, Germany",
    job_city: "Berlin",
    job_country: "DE",
    job_min_salary: 90000,
    job_max_salary: 100000,
    job_salary_currency: "EUR",
    job_salary_period: "YEAR",
    job_salary_string: "90000-100000 EUR",
    job_apply_link: "https://jobs.acme.example/old",
    apply_options: [{ publisher: "Acme Careers", apply_link: "https://careers.acme.example/old", is_direct: true }],
    job_posted_at_datetime_utc: "2026-09-01T00:00:00.000Z",
  };
  const stored = (searchRecord: Record<string, unknown>) => parseJsearchPayload({ search: searchRecord, detail, detail_source: "stored" }, PREFERENCE);

  it.each([
    ["no description key", undefined],
    ["a null description", null],
    ["an empty description", ""],
    ["a blank description", "  "],
  ])("takes the stored description when the search has %s (the same judgement the channel uses to ask for details)", (_name, description) => {
    const record: Record<string, unknown> = { ...search };
    if (description !== undefined) record.job_description = description;
    expect(stored(record).description).toBe(OLD_DESCRIPTION);
  });

  it("prefers the description of the new search to the stored one", () => {
    expect(stored({ ...search, job_description: "Written for this week's search." }).description).toBe("Written for this week's search.");
  });

  it("takes location, salary, apply link, apply options and time from the search, never from the stored detail", () => {
    const draft = stored(search);
    expect(draft.description).toBe(OLD_DESCRIPTION);
    expect(draft.locations).toEqual([{ label: "Hamburg", city: "Hamburg", countryCode: "DE" }]);
    expect(JSON.stringify(draft.locations)).not.toContain("Berlin");
    expect(draft.salary).toMatchObject({ min: 110000, max: 120000, currency: "EUR", period: "year" });
    expect(draft.salaryText).not.toContain("90000");
    expect(draft.applyUrl).toBe("https://jobs.acme.example/new");
    expect(draft.sourceUrl).toBe("https://jobs.acme.example/new");
    expect(draft.extra).toMatchObject({ applyLinks: 1 });
    expect(draft.postedAt?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("a freshly fetched detail (no marker) still overrides the search, as before", () => {
    const draft = parseJsearchPayload({ search, detail }, PREFERENCE);
    expect(draft.locations).toEqual([{ label: "Berlin, Germany", city: "Berlin", countryCode: "DE" }]);
    expect(draft.salaryText).toBe("90000-100000 EUR");
    expect(draft.applyUrl).toBe("https://careers.acme.example/old");
    expect(draft.description).toBe(OLD_DESCRIPTION);
  });

  it("parses payloads stored without the marker, and refuses any other marker value instead of treating it as fetched", () => {
    expect(() => parseJsearchPayload({ search, detail: null }, PREFERENCE)).not.toThrow();
    expect(() => parseJsearchPayload({ search, detail, detail_source: "fetched" }, PREFERENCE)).toThrow(ChannelError);
    expect(() => parseJsearchPayload({ search, detail, detail_source: null }, PREFERENCE)).toThrow(ChannelError);
  });

  it("the stored description still shapes the fields derived from it (accepted): an on-site description wins over the remote label", () => {
    const draft = stored({ ...search, job_is_remote: true });
    expect(draft.workplace).toBe("remote");
    const onsite = parseJsearchPayload({ search: { ...search, job_is_remote: true }, detail: { ...detail, job_description: "This role is fully on-site in our Berlin office." }, detail_source: "stored" }, PREFERENCE);
    expect(onsite.workplace).toBe("remote"); // the draft keeps the source's label; the pipeline reads the wording
    expect(normalizeDraft(onsite, shippedPipeline()).workplace).toBe("onsite");
  });
});
