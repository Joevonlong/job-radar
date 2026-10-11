// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createGreenhouseChannel, createLeverChannel, greenhouseAdapter, leverAdapter } from "@/lib/channels/ats";
import { wrapPosting } from "@/lib/channels/ats/envelope";
import { ChannelError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { depsWith, fixtureJson, inputs } from "./helpers";

interface GreenhouseFixture { jobs: unknown[] }

const ghSource = { ats: "greenhouse", token: "examplelabs", companyName: "Example Labs" } as const;
const lvSource = { ats: "lever", token: "examplecorp", companyName: "Example Corp" } as const;
const ghJobs = (fixtureJson("greenhouse-board.json") as GreenhouseFixture).jobs;
const lvPostings = fixtureJson("lever-postings.json") as unknown[];

const gh = (i: number) => greenhouseAdapter.parse(wrapPosting(ghSource, ghJobs[i]));
const lv = (i: number) => leverAdapter.parse(wrapPosting(lvSource, lvPostings[i]));

describe("greenhouse parse", () => {
  it("maps a full posting and passes the draft schema", () => {
    const draft = gh(0);
    expect(normalizedPostingDraftSchema.parse(draft)).toBeTruthy();
    expect(draft).toMatchObject({
      title: "Senior AI Engineer (m/f/d)",
      companyName: "Example Labs",
      workplace: "unknown",
      descriptionLanguage: "en",
      applyUrl: "https://job-boards.greenhouse.io/examplelabs/jobs/6186419001",
      sourceUrl: "https://job-boards.greenhouse.io/examplelabs/jobs/6186419001",
      salary: null,
      salaryText: null,
    });
    expect(draft.postedAt).toEqual(new Date("2026-09-14T10:42:28-04:00"));
    expect(draft.description).toBe("Build LLM products.\n\n- Python\n- RAG\n\nSalary: €85,000 – €105,000 & equity.");
    expect(draft.extra).toMatchObject({ ats: "greenhouse", requisitionId: "JR100001", departments: ["Engineering"], offices: ["Helsinki"] });
  });

  it("uses the displayed locations (one per `;`), not the office taxonomy", () => {
    expect(gh(0).locations).toEqual([
      { label: "Berlin, Germany", city: null, countryCode: null },
      { label: "München, Germany", city: null, countryCode: null },
    ]);
  });

  it("derives remote / hybrid from the location text, otherwise leaves it unknown (C3)", () => {
    expect(gh(1).workplace).toBe("remote");
    expect(gh(1).extra).toMatchObject({ remoteScope: "Remote - Germany" });
    expect(gh(2).workplace).toBe("hybrid");
    expect(gh(3).workplace).toBe("unknown");
  });

  it("tolerates missing optional fields and invalid urls", () => {
    const draft = greenhouseAdapter.parse(wrapPosting(ghSource, { id: 1, title: "KI Engineer", absolute_url: "not a url" }));
    expect(draft).toMatchObject({ locations: [], applyUrl: null, sourceUrl: null, description: "", workplace: "unknown" });
    expect(draft.descriptionLanguage).toBeUndefined();
  });

  it("rejects a posting without a title and a payload that is not an envelope", () => {
    expect(() => greenhouseAdapter.parse(wrapPosting(ghSource, { id: 1 }))).toThrow(ChannelError);
    expect(() => greenhouseAdapter.parse({ id: 1, title: "x" })).toThrow(/envelope/);
    expect(() => greenhouseAdapter.parse(wrapPosting(lvSource, ghJobs[0]))).toThrow(/greenhouse posting envelope/);
  });

  it("list() reads the board response and rejects other shapes", () => {
    expect(greenhouseAdapter.list(fixtureJson("greenhouse-board.json"))).toHaveLength(6);
    expect(() => greenhouseAdapter.list({ error: "x" })).toThrow(ChannelError);
    expect(() => greenhouseAdapter.list([])).toThrow(ChannelError);
  });

  it("describe() gives id, title, url and publication time; numeric and string ids both work", () => {
    expect(greenhouseAdapter.describe(ghJobs[0])).toEqual({
      externalId: "6186419001",
      title: "Senior AI Engineer (m/f/d)",
      url: "https://job-boards.greenhouse.io/examplelabs/jobs/6186419001",
      postedAt: new Date("2026-09-14T10:42:28-04:00"),
    });
    expect(greenhouseAdapter.describe({ id: "abc", title: "t" })?.externalId).toBe("abc");
    expect(greenhouseAdapter.describe({ title: "no id" })).toBeNull();
    expect(greenhouseAdapter.describe(null)).toBeNull();
  });
});

describe("lever parse", () => {
  it("maps a full posting incl. salary range, lists and additional text", () => {
    const draft = lv(0);
    expect(normalizedPostingDraftSchema.parse(draft)).toBeTruthy();
    expect(draft).toMatchObject({
      title: "Lead Applied Scientist (Example)",
      companyName: "Example Corp",
      workplace: "hybrid",
      contractHint: "Full Time",
      salary: { min: 120000, max: 150000, currency: "EUR", period: "year", raw: "EUR 120,000 - 150,000 per year" },
      salaryText: "EUR 120,000 - 150,000 per year",
      applyUrl: "https://jobs.lever.co/examplecorp/00000000-0000-4000-8000-000000000001/apply",
      sourceUrl: "https://jobs.lever.co/examplecorp/00000000-0000-4000-8000-000000000001",
    });
    expect(draft.locations).toEqual([{ label: "Berlin", city: null, countryCode: "DE" }]);
    expect(draft.postedAt).toEqual(new Date(1776323831956));
    expect(draft.description).toBe(
      "We build example software for imaginary customers.\n\nYour new adventure:\n- Lead a small team of scientists\n- Build agentic workflows\n\nDoes this sound like you?\n- 8+ years of applied science\n\nCompensation: EUR 120,000 - 150,000 plus stock options.",
    );
    expect(draft.extra).toMatchObject({ ats: "lever", team: "ML & Data Science", department: "DATA" });
  });

  it("supports monthly salary, onsite workplace, several locations (no guessed country)", () => {
    const draft = lv(1);
    expect(draft.workplace).toBe("onsite");
    expect(draft.salary).toMatchObject({ min: 600, max: 800, currency: "EUR", period: "month" });
    expect(draft.locations.map((l) => l.label)).toEqual(["London", "Remote - EU"]);
    expect(draft.locations.every((l) => l.countryCode === null)).toBe(true);
  });

  it("unspecified workplace is unknown; description falls back to stripped html; no salary stays null", () => {
    const draft = lv(2);
    expect(draft.workplace).toBe("unknown");
    expect(draft.description).toBe("Help & support customers.\nDaily.");
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBeNull();
    expect(draft.locations).toEqual([{ label: "Madrid", city: null, countryCode: null }]);
  });

  it("does not invent a salary from a one-time or malformed range, but keeps the text", () => {
    const draft = lv(3);
    expect(draft.workplace).toBe("remote");
    expect(draft.salary).toBeNull();
    expect(draft.salaryText).toBe("EUR 1000–1000 one-time");
    const swapped = leverAdapter.parse(
      wrapPosting(lvSource, { id: "x", text: "AI Engineer", salaryRange: { min: 9, max: 1, currency: "EUR", interval: "per-year-salary" } }),
    );
    expect(swapped.salary).toBeNull();
    const badCurrency = leverAdapter.parse(
      wrapPosting(lvSource, { id: "x", text: "AI Engineer", salaryRange: { min: 1, max: 9, currency: "euro", interval: "per-year-salary" } }),
    );
    expect(badCurrency.salary).toBeNull();
  });

  it("accepts the legacy interval spelling and on-site", () => {
    const draft = leverAdapter.parse(
      wrapPosting(lvSource, { id: "x", text: "AI Engineer", workplaceType: "on-site", salaryRange: { min: 1, max: 2, currency: "eur", interval: "year" } }),
    );
    expect(draft.workplace).toBe("onsite");
    expect(draft.salary).toMatchObject({ currency: "EUR", period: "year" });
  });

  it("rejects bad input and describe() needs an id", () => {
    expect(() => leverAdapter.parse(wrapPosting(lvSource, { id: "x" }))).toThrow(ChannelError);
    expect(() => leverAdapter.list({ postings: [] })).toThrow(ChannelError);
    expect(leverAdapter.list(lvPostings)).toHaveLength(4);
    expect(leverAdapter.describe({ text: "no id" })).toBeNull();
    expect(leverAdapter.describe(lvPostings[0])).toMatchObject({ externalId: "00000000-0000-4000-8000-000000000001", title: "Lead Applied Scientist (Example)" });
  });
});

describe("channel definitions", () => {
  it("are ats-family channels that ignore keyword queries", () => {
    const deps = depsWith(inputs([]));
    for (const channel of [createGreenhouseChannel(deps), createLeverChannel(deps)]) {
      expect(channel).toMatchObject({ family: "ats", kind: "ats", usesQueries: false });
    }
    expect(createGreenhouseChannel(deps).id).toBe("greenhouse");
    expect(createLeverChannel(deps).id).toBe("lever");
  });
});
