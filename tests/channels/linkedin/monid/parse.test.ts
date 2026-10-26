// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { jobIdOf } from "@/lib/channels/linkedin/apify/contract";
import { jobRecordSchema } from "@/lib/channels/linkedin/brightdata/contract";
import { monidDescriptionHtml, monidJobId, parseMonidJob, unidentifiedExternalId } from "@/lib/channels/linkedin/monid/parse";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import jobs from "../../../fixtures/monid/harvestapi-jobs.json";

const job = jobs[0]!;

describe("harvestapi postings", () => {
  it("maps fields without inferring the city or changing the raw payload", () => {
    const before = structuredClone(job);
    const draft = parseMonidJob(job);
    expect(normalizedPostingDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft).toMatchObject({
      title: job.title, companyName: job.company.name, workplace: "hybrid",
      locations: [{ label: "Example City, Germany", city: null, countryCode: "DE" }],
      description: job.descriptionText, postedAt: new Date(job.postedDate),
      sourceUrl: job.linkedinUrl, applyUrl: job.applyMethod!.companyApplyUrl,
      salaryText: job.salary.text,
      salary: { min: 70000, max: 90000, currency: "EUR", period: "year", raw: job.salary.text },
      extra: { jobId: "4385163817", company: { name: "Example Systems" }, applicants: 12, views: 30, expireAt: job.expireAt, jobState: "LISTED", compensationSource: "EMPLOYER" },
    });
    expect(monidDescriptionHtml(job)).toEqual([{ path: "descriptionHtml", html: job.descriptionHtml }]);
    expect(job).toEqual(before);
  });

  it("shares identity with Apify and Bright Data for numeric ids and URL fallback", () => {
    const id = "4385163817";
    expect(monidJobId({ id: Number(id) })).toBe(jobIdOf({ id }));
    expect(monidJobId({ linkedinUrl: job.linkedinUrl })).toBe(id);
    expect(monidJobId({ id: undefined })).toBeNull();
    expect(monidJobId({ id: null })).toBeNull();
    expect(monidJobId({ id: "invalid", linkedinUrl: job.linkedinUrl })).toBe(id);
    expect(jobRecordSchema.parse({ job_posting_id: id, url: job.linkedinUrl, job_title: "Engineer", company_name: "Example" }).job_posting_id).toBe(monidJobId(job));
    expect(parseMonidJob({ ...job, applyMethod: null }).applyUrl).toBe(job.linkedinUrl);
  });

  it.each([
    ["on_site", "onsite"], ["hybrid", "hybrid"], ["remote", "remote"], [undefined, "unknown"], ["other", "unknown"],
  ])("maps workplace %s to %s using only the posting", (workplaceType, expected) => {
    expect(parseMonidJob({ ...job, workplaceType, workRemoteAllowed: true }).workplace).toBe(expected);
  });

  it.each([false, undefined, null])("retains non-employer salary only in extra: %s", (providedByEmployer) => {
    const draft = parseMonidJob({ ...job, salary: { ...job.salary, providedByEmployer } });
    expect(draft.salaryText).toBeNull();
    expect(draft.salary).toBeUndefined();
    expect(draft.extra?.salary).toMatchObject({ text: job.salary.text });
  });

  it.each([["YEARLY", "year"], ["MONTHLY", "month"], ["WEEKLY", "week"], ["DAILY", "day"], ["HOURLY", "hour"]])("maps pay period %s", (payPeriod, period) => {
    expect(parseMonidJob({ ...job, salary: { ...job.salary, payPeriod } }).salary?.period).toBe(period);
  });

  it("keeps text for an unknown period or currency and supports a single salary bound", () => {
    for (const override of [{ payPeriod: "UNKNOWN" }, { currency: null }]) {
      expect(parseMonidJob({ ...job, salary: { ...job.salary, ...override } })).toMatchObject({ salaryText: job.salary.text });
      expect(parseMonidJob({ ...job, salary: { ...job.salary, ...override } }).salary).toBeUndefined();
    }
    expect(parseMonidJob({ ...job, salary: { ...job.salary, max: null } }).salary).toMatchObject({ min: 70000, max: null });
    expect(parseMonidJob({ ...job, salary: { ...job.salary, min: null } }).salary).toMatchObject({ min: null, max: 90000 });
  });

  it("refuses malformed jobs and quarantined identities without copying recruiter details", () => {
    for (const payload of [null, 2, {}, { ...job, title: "" }, { ...job, id: undefined, linkedinUrl: "https://example.com/job" }]) {
      expect(() => parseMonidJob(payload)).toThrow(expect.objectContaining({ code: "parse" }));
    }
    const draft = parseMonidJob({ ...job, recruiter: { name: "Fictional Recruiter" }, company: { ...job.company, recruiter: { name: "Fictional Recruiter" } } });
    expect(JSON.stringify(draft)).not.toContain("Fictional Recruiter");
    expect(monidDescriptionHtml({})).toEqual([]);
  });

  it("hashes canonical JSON recursively, preserving array order", () => {
    const first = { b: [2, { z: true, a: null }], a: 1 };
    const second = { a: 1, b: [2, { a: null, z: true }] };
    const canonical = '{"a":1,"b":[2,{"a":null,"z":true}]}';
    expect(unidentifiedExternalId(first)).toBe(`unidentified:${createHash("sha256").update(canonical).digest("hex")}`);
    expect(unidentifiedExternalId(first)).toBe(unidentifiedExternalId(second));
    expect(unidentifiedExternalId({ a: [1, 2] })).not.toBe(unidentifiedExternalId({ a: [2, 1] }));
  });
});
