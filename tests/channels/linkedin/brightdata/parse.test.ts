// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { parseBrightDataJob } from "@/lib/channels/linkedin/brightdata";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

const records = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../../fixtures/brightdata/snapshot-berlin.json"), "utf8")) as Array<Record<string, unknown>>;
const [full, noSalary, numericId] = records as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];

describe("parseBrightDataJob", () => {
  it("maps job, company, location, text, apply link, posted date and the source-stated salary", () => {
    const draft = normalizedPostingDraftSchema.parse(parseBrightDataJob(full));
    expect(draft).toMatchObject({
      title: "Senior ML Engineer",
      companyName: "Example GmbH",
      locations: [{ label: "Berlin, Berlin, Germany", city: "Berlin", countryCode: "DE" }],
      workplace: "unknown", // the dataset has no workplace field
      contractHint: "Full-time",
      seniorityHint: "Mid-Senior level",
      salaryText: "€80,000.00/yr - €100,000.00/yr",
      salary: { min: 80000, max: 100000, currency: "EUR", period: "year", raw: "€80,000.00/yr - €100,000.00/yr" },
      applyUrl: "https://careers.example.com/jobs/4385163817",
      sourceUrl: "https://www.linkedin.com/jobs/view/senior-ml-engineer-4385163817?_l=en",
      extra: { companyId: "12345" },
    });
    expect(draft.postedAt?.toISOString()).toBe("2026-10-07T06:30:00.000Z");
    expect(draft.description).toContain("Build production machine-learning systems.");
    expect(draft.description).toContain("Python & PyTorch");
    expect(draft.description).not.toMatch(/<|&amp;/);
  });

  it("states nothing the posting does not say (C3): no salary, unknown workplace, apply falls back to the LinkedIn URL", () => {
    const draft = normalizedPostingDraftSchema.parse(parseBrightDataJob(noSalary));
    expect(draft.salary ?? null).toBeNull();
    expect(draft.salaryText).toBeNull();
    expect(draft.workplace).toBe("unknown");
    expect(draft.applyUrl).toBe("https://www.linkedin.com/jobs/view/4385163819");
    expect(draft.seniorityHint).toBeNull();
  });

  it("prefers the formatted HTML description and keeps its paragraphs and list items", () => {
    const draft = normalizedPostingDraftSchema.parse(
      parseBrightDataJob({
        ...full,
        job_summary: "Intro text What you will do Build systems Python and PyTorch Show more Show less",
        job_description_formatted:
          "<section><p>Intro text &amp; context.</p><strong>What you will do</strong><ul><li>Build systems</li><li>Python &amp; PyTorch</li></ul><p>Apply &lt;now&gt;.<br>Thanks</p></section>",
      }),
    );
    expect(draft.description).toBe("Intro text & context.\n\nWhat you will do\n- Build systems\n- Python & PyTorch\n\nApply <now>.\nThanks");
  });

  it("falls back to the one-paragraph summary when there is no formatted description", () => {
    const draft = normalizedPostingDraftSchema.parse(parseBrightDataJob({ ...full, job_description_formatted: "  ", job_summary: "Plain summary text Show more Show less" }));
    expect(draft.description).toBe("Plain summary text Show more Show less"); // the pipeline cuts the leftover (description.trailing_ui_patterns)
  });

  it("accepts a numeric job id and a record with missing optional fields", () => {
    const draft = normalizedPostingDraftSchema.parse(parseBrightDataJob(numericId));
    expect(draft.title).toBe("AI Engineer (older posting)");
    expect(draft.postedAt?.toISOString()).toBe("2026-10-06T14:00:00.000Z");
  });

  it("reads the currency symbol the dataset writes (\"€\", \"$\") as an ISO code and keeps the source's own range text as raw", () => {
    const draft = parseBrightDataJob({
      ...full,
      job_base_pay_range: "€75,000.00/yr - €100,000.00/yr",
      base_salary: { currency: "€", min_amount: 75000, max_amount: 100000, payment_period: "yr" },
    });
    expect(draft.salary).toEqual({ min: 75000, max: 100000, currency: "EUR", period: "year", raw: "€75,000.00/yr - €100,000.00/yr" });
    const usd = parseBrightDataJob({ ...full, base_salary: { currency: "$", min_amount: 120000, max_amount: 150000, payment_period: "yr" } });
    expect(usd.salary).toMatchObject({ currency: "USD", min: 120000, max: 150000 });
  });

  it("keeps salary text but no structured salary when currency or period are unusable", () => {
    const draft = parseBrightDataJob({
      ...full,
      job_base_pay_range: "80k-100k",
      base_salary: { currency: "coins", min_amount: 80000, max_amount: 100000, payment_period: "year" },
    });
    expect(draft.salaryText).toBe("80k-100k");
    expect(draft.salary ?? null).toBeNull();
    const noPeriod = parseBrightDataJob({ ...full, base_salary: { currency: "EUR", min_amount: 1, max_amount: 2, payment_period: "decade" } });
    expect(noPeriod.salary ?? null).toBeNull();
  });

  it("maps hourly / monthly salary periods and builds raw text when the source gave none", () => {
    const hourly = parseBrightDataJob({ ...full, job_base_pay_range: null, base_salary: { currency: "eur", min_amount: 40, max_amount: null, payment_period: "hr" } });
    expect(hourly.salary).toMatchObject({ min: 40, max: null, currency: "EUR", period: "hour" });
    expect(hourly.salary?.raw).toContain("EUR");
    expect(hourly.salaryText).toBeNull();
  });

  it("ignores an unusable apply link and falls back to the LinkedIn URL", () => {
    expect(parseBrightDataJob({ ...full, apply_link: "javascript:alert(1)" }).applyUrl).toBe(full.url);
  });

  it("raises a parse error for records without the essentials", () => {
    for (const bad of [null, "x", {}, { ...full, job_title: "" }, { ...full, company_name: undefined }, { ...full, url: undefined }, { ...full, url: "not a url" }]) {
      expect(() => parseBrightDataJob(bad)).toThrow(ChannelError);
    }
  });
});
