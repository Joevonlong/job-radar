// @vitest-environment node
import { describe, expect, it } from "vitest";

import { parseBrightDataJob } from "@/lib/channels/linkedin/brightdata";
import { parseApifyJob } from "@/lib/channels/linkedin/apify";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { FIXTURE_ITEMS } from "./helpers";

describe("parseApifyJob", () => {
  it("maps a full record to the normalized draft (HTML kept as paragraphs, salary as stated text)", () => {
    const draft = normalizedPostingDraftSchema.parse(parseApifyJob(FIXTURE_ITEMS[0]));
    expect(draft).toMatchObject({
      title: "Senior ML Engineer",
      companyName: "Example GmbH",
      locations: [{ label: "Berlin, Berlin, Germany", city: "Berlin", countryCode: "DE" }],
      workplace: "unknown",
      contractHint: "Full-time",
      seniorityHint: "Mid-Senior level",
      salaryText: "€80,000.00/yr - €100,000.00/yr",
      applyUrl: "https://www.linkedin.com/jobs/view/senior-ml-engineer-at-example-gmbh-4385163817",
      sourceUrl: "https://www.linkedin.com/jobs/view/senior-ml-engineer-at-example-gmbh-4385163817",
      extra: { jobId: "4385163817", applyType: "EASY_APPLY" },
    });
    expect(draft.description).toBe("Build production machine-learning systems.\nPython & PyTorch\nGerman or English");
    expect(draft.postedAt?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("falls back to the plain-text description and states no salary when there is none", () => {
    const draft = normalizedPostingDraftSchema.parse(parseApifyJob(FIXTURE_ITEMS[1]));
    expect(draft.description).toBe("Work on large language model products.");
    expect(draft.salaryText).toBeNull();
    expect(draft.seniorityHint).toBeNull();
  });

  it("builds the canonical job URL from the id when the record has no url", () => {
    const draft = parseApifyJob({ id: "4385163899", title: "AI Engineer", companyName: "Acme" });
    expect(draft.sourceUrl).toBe("https://www.linkedin.com/jobs/view/4385163899");
  });

  it("raises a parse error for a record without title/company, or without url and id", () => {
    expect(() => parseApifyJob({ id: "1234567", url: "https://www.linkedin.com/jobs/view/1234567" })).toThrowError(expect.objectContaining({ code: "parse" }));
    expect(() => parseApifyJob({ title: "x", companyName: "y" })).toThrowError(expect.objectContaining({ code: "parse" }));
    expect(() => parseApifyJob("nope")).toThrowError(expect.objectContaining({ code: "parse" }));
  });

  it("draws the same company, title and job as the Bright Data mapping for the same posting", () => {
    const bright = parseBrightDataJob({
      url: "https://www.linkedin.com/jobs/view/4385163819",
      job_posting_id: "4385163819",
      job_title: "LLM Engineer",
      company_name: "No Salary AG",
      job_location: "Berlin, Germany",
      job_summary: "Work on large language model products.",
      job_employment_type: "Full-time",
    });
    const apify = parseApifyJob(FIXTURE_ITEMS[1]);
    expect({ title: apify.title, companyName: apify.companyName, description: apify.description, sourceUrl: apify.sourceUrl, contractHint: apify.contractHint }).toEqual({
      title: bright.title,
      companyName: bright.companyName,
      description: bright.description,
      sourceUrl: bright.sourceUrl,
      contractHint: bright.contractHint,
    });
    expect(apify.locations[0]?.countryCode).toBe("DE");
  });
});
