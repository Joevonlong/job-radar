// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ashbyAdapter, createAshbyChannel } from "@/lib/channels/ats";
import { wrapPosting } from "@/lib/channels/ats/envelope";
import { ChannelError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";

import { atsChannelsWith, atsContext, company, depsWith, fixtureJson, inputs, response, routedFetch } from "./helpers";

const URL_PART = "api.ashbyhq.com/posting-api/job-board/examplelabs?includeCompensation=true";
const source = { ats: "ashby", token: "examplelabs", companyName: "Example Labs" } as const;
const jobs = (fixtureJson("ashby-board.json") as { jobs: unknown[] }).jobs;
const draft = (i: number) => ashbyAdapter.parse(wrapPosting(source, jobs[i]));
const ashby = company({ name: "Example Labs", ats: "ashby", token: "examplelabs" });

function channel(opts: { watched?: string[] } = {}) {
  const deps = depsWith(inputs([ashby], { watched: opts.watched ?? [] }));
  return { channel: createAshbyChannel(deps), store: deps.memory };
}

describe("ashby parse", () => {
  it("maps a posting with a salary range (salary component only, not bonus or equity)", () => {
    const d = draft(0);
    expect(normalizedPostingDraftSchema.parse(d)).toBeTruthy();
    expect(d).toMatchObject({
      title: "Account Executive - AI & Enterprise Solutions - m/f/d",
      companyName: "Example Labs",
      workplace: "unknown",
      contractHint: "FullTime",
      salaryText: "€77K - €90K",
      salary: { min: 77000, max: 90000, currency: "EUR", period: "year", raw: "€77K - €90K" },
      sourceUrl: "https://jobs.ashbyhq.com/examplelabs/a1000000-0000-4000-8000-000000000001",
      applyUrl: "https://jobs.ashbyhq.com/examplelabs/a1000000-0000-4000-8000-000000000001/application",
    });
    expect(d.locations).toEqual([{ label: "Berlin", city: null, countryCode: null }]);
    expect(d.postedAt).toBeInstanceOf(Date);
    expect(d.description.length).toBeGreaterThan(50);
    expect(d.extra).toMatchObject({ ats: "ashby", department: expect.any(String) });
  });

  it("maps workplaceType, and falls back to the isRemote flag only for remote (C3)", () => {
    expect(draft(1).workplace).toBe("onsite");
    expect(draft(2).workplace).toBe("hybrid");
    expect(draft(4).workplace).toBe("remote");
    expect(ashbyAdapter.parse(wrapPosting(source, { id: "x", title: "AI Engineer", isRemote: true })).workplace).toBe("remote");
    expect(ashbyAdapter.parse(wrapPosting(source, { id: "x", title: "AI Engineer", isRemote: false })).workplace).toBe("unknown");
  });

  it("keeps a salary that has no range as min = max, and gives null without a salary component", () => {
    expect(draft(3).salary).toMatchObject({ min: 20800, max: 20800, currency: "EUR", period: "year" });
    expect(draft(2).salary).toBeNull();
    expect(draft(2).salaryText).toBeNull();
    expect(draft(4).salary).toBeNull();
  });

  it("does not guess a salary out of unusable components", () => {
    const withComponent = (component: Record<string, unknown>) =>
      ashbyAdapter.parse(
        wrapPosting(source, {
          id: "x",
          title: "AI Engineer",
          compensation: { compensationTierSummary: "tier text", summaryComponents: [{ compensationType: "Salary", ...component }] },
        }),
      );
    expect(withComponent({ interval: "NONE", currencyCode: "EUR", minValue: 1, maxValue: 2 }).salary).toBeNull();
    expect(withComponent({ interval: "1 YEAR", currencyCode: null, minValue: 1, maxValue: 2 }).salary).toBeNull();
    expect(withComponent({ interval: "1 YEAR", currencyCode: "EUR", minValue: 9, maxValue: 2 }).salary).toBeNull();
    expect(withComponent({ interval: "1 YEAR", currencyCode: "EUR", minValue: null, maxValue: null }).salary).toBeNull();
    const hourly = withComponent({ interval: "1 HOUR", currencyCode: "usd", minValue: 40, maxValue: null });
    expect(hourly.salary).toMatchObject({ min: 40, max: null, currency: "USD", period: "hour" });
    expect(hourly.salaryText).toBe("tier text");
  });

  it("lists every secondary location, and uses the HTML description when there is no plain one", () => {
    const d = ashbyAdapter.parse(
      wrapPosting(source, {
        id: "x",
        title: "AI Engineer",
        location: "Berlin Office",
        address: { postalAddress: { addressLocality: "Berlin", addressCountry: "Germany" } },
        secondaryLocations: [{ location: "Germany" }, { location: "Berlin Office" }, { location: "" }],
        descriptionHtml: "<p>Hello</p><ul><li>One</li></ul>",
      }),
    );
    expect(d.locations).toEqual([
      { label: "Berlin Office", city: "Berlin", countryCode: null },
      { label: "Germany", city: null, countryCode: null },
    ]);
    expect(d.description).toBe("Hello\n\n- One");
  });

  it("rejects a posting without a title and a payload from another ATS", () => {
    expect(() => ashbyAdapter.parse(wrapPosting(source, { id: "x" }))).toThrow(ChannelError);
    expect(() => ashbyAdapter.parse(wrapPosting({ ...source, ats: "lever" }, jobs[0]))).toThrow(/ashby posting envelope/);
  });

  it("list() drops unlisted postings and rejects other shapes; describe() gives id, title, url, time", () => {
    expect(ashbyAdapter.list({ jobs })).toHaveLength(5);
    expect(() => ashbyAdapter.list([])).toThrow(ChannelError);
    expect(() => ashbyAdapter.list({ error: "x" })).toThrow(ChannelError);
    expect(ashbyAdapter.describe(jobs[0])).toMatchObject({
      externalId: "a1000000-0000-4000-8000-000000000001",
      title: "Account Executive - AI & Enterprise Solutions - m/f/d",
      url: "https://jobs.ashbyhq.com/examplelabs/a1000000-0000-4000-8000-000000000001",
    });
    expect(ashbyAdapter.describe({ title: "no id" })).toBeNull();
  });
});

describe("ashby sweep", () => {
  const board = () => response(200, fixtureJson("ashby-board.json"), { ETag: 'W/"job-board:v1"' });
  const withTerms = (include: string[]) =>
    atsChannelsWith("ashby", (b) => {
      b.title_prefilter = { enabled: true, include_terms: include, exclude_terms: [] };
    });

  it("requests the board with compensation and keeps titles matching keywords / include terms", async () => {
    const { fetch, requests } = routedFetch([[URL_PART, board()]]);
    const { ctx, query, logs } = atsContext("ashby", fetch, { channels: withTerms(["AI"]) });
    const postings = await channel().channel.collect(query, ctx);

    expect(requests[0]?.url).toBe("https://api.ashbyhq.com/posting-api/job-board/examplelabs?includeCompensation=true");
    expect(postings.map((p) => p.externalId)).toEqual([
      "a1000000-0000-4000-8000-000000000001",
      "a1000000-0000-4000-8000-000000000002",
    ]);
    expect(logs.filter((l) => l.message === "ats board").map((l) => l.fields)).toEqual([
      { channel: "ashby", company: "Example Labs", board: "examplelabs", outcome: "changed", fetched: 5, kept: 2 },
    ]);
    expect(postings[0]?.url).toBe("https://jobs.ashbyhq.com/examplelabs/a1000000-0000-4000-8000-000000000001");
    for (const p of postings) expect(normalizedPostingDraftSchema.parse(channel().channel.parse(p.payload)).companyName).toBe("Example Labs");
  });

  it("omits the compensation parameter when include_compensation is off", async () => {
    const { fetch, requests } = routedFetch([["api.ashbyhq.com", board()]]);
    const channels = atsChannelsWith("ashby", (b) => {
      b.include_compensation = false;
    });
    const { ctx, query } = atsContext("ashby", fetch, { channels });
    await channel().channel.collect(query, ctx);
    expect(requests[0]?.url).toBe("https://api.ashbyhq.com/posting-api/job-board/examplelabs");
  });

  it("answers 304 with an unchanged board: nothing fetched, postings touched", async () => {
    const { channel: c, store } = channel();
    const first = atsContext("ashby", routedFetch([[URL_PART, board()]]).fetch, { channels: withTerms(["AI"]) });
    await c.collect(first.query, first.ctx);
    expect(store.states.get("ashby:examplelabs")?.etag).toBe('W/"job-board:v1"');

    const second = routedFetch([[URL_PART, response(304)]]);
    const b = atsContext("ashby", second.fetch, { channels: withTerms(["AI"]) });
    expect(await c.collect(b.query, b.ctx)).toEqual([]);
    expect(second.requests[0]?.headers["If-None-Match"]).toBe('W/"job-board:v1"');
    expect(store.touched.at(-1)).toHaveLength(2);
    expect(b.logs.filter((l) => l.message === "ats board").map((l) => l.fields)).toEqual([
      { channel: "ashby", company: "Example Labs", board: "examplelabs", outcome: "not_modified", fetched: 0, kept: 0 },
    ]);
  });

  it("a board that does not exist fails the sweep with a not-found error", async () => {
    const { ctx, query } = atsContext("ashby", routedFetch([[URL_PART, response(404, "Not Found")]]).fetch);
    await expect(channel().channel.collect(query, ctx)).rejects.toThrow(/not found/);
  });

  it("a board that answers with another shape fails with a parse error", async () => {
    const { ctx, query } = atsContext("ashby", routedFetch([[URL_PART, response(200, { jobs: "nope" })]]).fetch);
    await expect(channel().channel.collect(query, ctx)).rejects.toMatchObject({ code: "parse" });
  });
});
