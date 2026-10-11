import { describe, expect, it } from "vitest";

import { distinctFamilies, pickApplyTarget, postingLink, safeHttpUrl, sourceLink } from "@/lib/dashboard/apply";
import { statusAfterIgnoreKey, statusAfterInterestKey } from "@/lib/dashboard/status";
import type { JobSourceRef } from "@/lib/db/queries/types";

describe("s key", () => {
  it("toggles new <-> interested and leaves later states alone", () => {
    expect(statusAfterInterestKey(null)).toBe("interested");
    expect(statusAfterInterestKey("new")).toBe("interested");
    expect(statusAfterInterestKey("interested")).toBe("new");
    expect(statusAfterInterestKey("applied")).toBeNull();
    expect(statusAfterInterestKey("archived")).toBeNull();
  });
});

describe("x key", () => {
  it("ignores (archived) and restores an ignored job to new", () => {
    expect(statusAfterIgnoreKey(null)).toBe("archived");
    expect(statusAfterIgnoreKey("interested")).toBe("archived");
    expect(statusAfterIgnoreKey("archived")).toBe("new");
    // jobs further in the application flow are never ignored by a key press
    for (const status of ["preparing", "applied", "interviewing", "offer", "rejected", "withdrawn"] as const) expect(statusAfterIgnoreKey(status)).toBeNull();
  });
});

const source = (channelId: string, family: string, priority: number, url: string | null, applyUrl: string | null = null): JobSourceRef => ({ channelId, family, priority, url, applyUrl });

describe("pickApplyTarget", () => {
  it("takes the lowest priority number that has a url", () => {
    const sources = [source("indeed", "indeed", 40, "https://i.example/1"), source("greenhouse", "ats", 10, null), source("lever", "ats", 12, "https://l.example/1")];
    expect(pickApplyTarget(sources)?.channelId).toBe("lever");
  });
  it("counts a direct apply link even when the posting url is missing, and prefers it for the link", () => {
    const only = source("greenhouse", "ats", 10, null, "https://a.example/apply");
    expect(pickApplyTarget([only])).toBe(only);
    expect(sourceLink(only)).toBe("https://a.example/apply");
    expect(sourceLink(source("lever", "ats", 10, "https://l.example/p", "https://l.example/apply"))).toBe("https://l.example/apply");
    expect(sourceLink(source("lever", "ats", 10, "https://l.example/p"))).toBe("https://l.example/p");
  });
  it("View posting opens the posting page on an ATS board, not the application form", () => {
    expect(postingLink(source("ashby", "ats", 10, "https://jobs.ashbyhq.com/acme/1", "https://jobs.ashbyhq.com/acme/1/application"))).toBe("https://jobs.ashbyhq.com/acme/1");
    // no posting url: the apply link is the fallback
    expect(postingLink(source("ashby", "ats", 10, null, "https://jobs.ashbyhq.com/acme/1/application"))).toBe("https://jobs.ashbyhq.com/acme/1/application");
    expect(postingLink(source("ashby", "ats", 10, "https://jobs.ashbyhq.com/acme/1"))).toBe("https://jobs.ashbyhq.com/acme/1");
    // an aggregator's apply link is the employer page it picked (JSearch publisher preference): it stays first
    expect(postingLink(source("jsearch", "google", 40, "https://publisher.example/1", "https://employer.example/job/1"))).toBe("https://employer.example/job/1");
    expect(postingLink(source("jsearch", "google", 40, "https://publisher.example/1"))).toBe("https://publisher.example/1");
    expect(postingLink(source("indeed", "indeed", 40, null))).toBeNull();
  });
  it("returns null when no source has a url", () => {
    expect(pickApplyTarget([source("indeed", "indeed", 40, null)])).toBeNull();
    expect(pickApplyTarget([])).toBeNull();
  });
});

describe("safeHttpUrl", () => {
  it("only lets http(s) through", () => {
    expect(safeHttpUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});

describe("distinctFamilies", () => {
  it("keeps first-seen order without duplicates", () => {
    const sources = [source("a", "ats", 10, null), source("b", "linkedin", 20, null), source("c", "linkedin", 25, null)];
    expect(distinctFamilies(sources)).toEqual(["ats", "linkedin"]);
  });
});
