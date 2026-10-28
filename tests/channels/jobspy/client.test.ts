// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import {
  buildSearchRequest,
  channelErrorFromSidecar,
  rawPostingsFromJobs,
  resolveJobspySettings,
  searchJobspy,
  searchTermFor,
} from "@/lib/channels/jobspy";
import { silentLogger } from "@/lib/channels/logger";

import { httpResponse, jobspyContext, jobspySettings, loadJobspyFixture, query } from "./helpers";

describe("resolveJobspySettings", () => {
  const settings = jobspySettings({ url: "http://127.0.0.1:8000/" });

  it("uses the configured URL without a trailing slash", () => {
    expect(resolveJobspySettings(settings, {}).url).toBe("http://127.0.0.1:8000");
  });

  it("lets JOBSPY_URL override the config, ignoring an empty value", () => {
    expect(resolveJobspySettings(settings, { JOBSPY_URL: "http://jobspy:8000" }).url).toBe("http://jobspy:8000");
    expect(resolveJobspySettings(settings, { JOBSPY_URL: "" }).url).toBe("http://127.0.0.1:8000");
  });

  it("rejects a malformed override without echoing it", () => {
    expect(() => resolveJobspySettings(settings, { JOBSPY_URL: "ftp://secret-host" })).toThrowError(/JOBSPY_URL is not a valid http/);
    try {
      resolveJobspySettings(settings, { JOBSPY_URL: "not a url" });
    } catch (error) {
      expect((error as Error).message).not.toContain("not a url");
    }
  });
});

describe("request building", () => {
  const settings = jobspySettings({ proxies: ["http://p.example:1"], linkedin_fetch_description: true });

  it("quotes keywords into an OR group", () => {
    expect(searchTermFor(["AI Engineer", 'KI "Entwickler"', "  "])).toBe('"AI Engineer" OR "KI Entwickler"');
  });

  it("maps a located query", () => {
    expect(buildSearchRequest("indeed", query(), settings)).toEqual({
      site: "indeed",
      search_term: '"AI Engineer" OR "LLM Engineer"',
      location: "Berlin",
      hours_old: 24,
      results_wanted: 10,
      is_remote: false,
      country_indeed: "germany",
      linkedin_fetch_description: false,
      proxies: ["http://p.example:1"],
    });
  });

  it("uses the configured remote location and the LinkedIn description flag", () => {
    const remote = query({ location: null, remote: true, remoteScope: "home_country" });
    expect(buildSearchRequest("linkedin", remote, settings)).toMatchObject({ location: "Germany", is_remote: true, linkedin_fetch_description: true });
    const worldwide = query({ location: null, remote: true, remoteScope: "worldwide" });
    expect(buildSearchRequest("linkedin", worldwide, settings).location).toBeNull();
    expect(buildSearchRequest("linkedin", worldwide, jobspySettings({ linkedin_fetch_description: false })).linkedin_fetch_description).toBe(false);
  });

  it("an Indeed search needs an Indeed country, LinkedIn and Google do not", () => {
    const noCountry = jobspySettings({ country_indeed: "" });
    expect(() => buildSearchRequest("indeed", query(), noCountry)).toThrowError(/Indeed does not serve/);
    expect(buildSearchRequest("linkedin", query(), noCountry)).not.toHaveProperty("country_indeed");
    expect(buildSearchRequest("google", query(), noCountry)).not.toHaveProperty("country_indeed");
  });

  it("refuses a query without keywords", () => {
    expect(() => buildSearchRequest("indeed", query({ keywords: [] }), settings)).toThrowError(ChannelError);
  });
});

describe("searchJobspy", () => {
  const settings = jobspySettings();
  const request = buildSearchRequest("indeed", query(), settings);

  it("posts the request and validates the response", async () => {
    const fixture = loadJobspyFixture("indeed");
    const { ctx, calls } = jobspyContext(() => httpResponse(200, fixture));
    const response = await searchJobspy(ctx, settings, request);
    expect(response.count).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://jobspy.test:8000/search", method: "POST", body: request });
  });

  it("maps 429 to rate_limited and does not retry", async () => {
    const { ctx, calls } = jobspyContext(() => httpResponse(429, { code: "rate_limited", message: "LinkedIn response status code 429" }));
    const error = await searchJobspy(ctx, settings, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "rate_limited", status: 429 });
    expect(calls).toHaveLength(1);
  });

  it("does not start another scrape after a timed-out POST", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, calls } = jobspyContext((_call, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
      const result = searchJobspy(ctx, { ...settings, timeout_ms: 10 }, request).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toMatchObject({ code: "network" });
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start another scrape after a plain HTTP 500", async () => {
    const { ctx, calls } = jobspyContext(() => httpResponse(500, "internal server error"));
    await expect(searchJobspy(ctx, settings, request)).rejects.toMatchObject({ code: "network" });
    expect(calls).toHaveLength(1);
  });

  it("maps 502 blocked and upstream_error", async () => {
    const blocked = jobspyContext(() => httpResponse(502, { code: "blocked", message: "Indeed response status code 403" }));
    await expect(searchJobspy(blocked.ctx, settings, request)).rejects.toMatchObject({ code: "blocked", retryable: false });
    const upstream = jobspyContext(() => httpResponse(502, { code: "upstream_error", message: "Google returned no job data" }));
    await expect(searchJobspy(upstream.ctx, settings, request)).rejects.toMatchObject({ code: "network", retryable: false });
    expect(upstream.calls).toHaveLength(1);
  });

  it("classifies by status when the error body is not the sidecar's", async () => {
    const { ctx } = jobspyContext(() => httpResponse(429, "<html>too many</html>"));
    await expect(searchJobspy(ctx, settings, request)).rejects.toMatchObject({ code: "rate_limited" });
    const bad = jobspyContext(() => httpResponse(502, "{}"));
    await expect(searchJobspy(bad.ctx, settings, request)).rejects.toMatchObject({ code: "network", retryable: false });
  });

  it("maps a rejected request (422) to a non-retryable unknown error", async () => {
    const { ctx } = jobspyContext(() => httpResponse(422, { code: "invalid_request", message: "search_term: too short" }));
    await expect(searchJobspy(ctx, settings, request)).rejects.toMatchObject({ code: "unknown", retryable: false });
  });

  it("raises a parse error when a 200 does not match the schema", async () => {
    const { ctx } = jobspyContext(() => httpResponse(200, { site: "indeed", jobs: "nope" }));
    await expect(searchJobspy(ctx, settings, request)).rejects.toMatchObject({ code: "parse" });
    const wrongSite = jobspyContext(() => httpResponse(200, { site: "linkedin", count: 0, jobs: [] }));
    await expect(searchJobspy(wrongSite.ctx, settings, request)).rejects.toMatchObject({ code: "parse" });
  });

  it("lets other server errors through the framework's classification", async () => {
    const { ctx } = jobspyContext(() => httpResponse(500, "boom"));
    await expect(searchJobspy(ctx, settings, request)).rejects.toMatchObject({ code: "network" });
  });
});

describe("channelErrorFromSidecar", () => {
  it("never exceeds a bounded message", () => {
    const error = channelErrorFromSidecar(502, { code: "upstream_error", message: "x".repeat(5000) });
    expect(error.message.length).toBeLessThan(300);
  });
});

describe("rawPostingsFromJobs", () => {
  it("keeps postings verbatim, keyed by jobspy id, and drops private fields", () => {
    const jobs = [
      { id: "in-1", job_url: "https://x.test/1", date_posted: "2026-10-06", title: "A", emails: "a@b.c", phone: "1", company_phone: "2" },
      { id: "in-1", job_url: "https://x.test/1", title: "duplicate" },
      { job_url: "https://x.test/2", title: "no id" },
      { title: "no id and no url" },
    ];
    const out = rawPostingsFromJobs(jobs, { logger: silentLogger });
    expect(out.map((p) => p.externalId)).toEqual(["in-1", "https://x.test/2"]);
    expect(out[0]).toMatchObject({ url: "https://x.test/1", payload: { id: "in-1", title: "A", date_posted: "2026-10-06" } });
    expect(out[0]?.payload).not.toHaveProperty("emails");
    expect(out[0]?.payload).not.toHaveProperty("phone");
    expect(out[0]?.payload).not.toHaveProperty("company_phone");
    expect(out[0]?.postedAt?.toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });
});
