// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { createCycleCache } from "@/lib/channels/web/cache";
import { extractJsonAfter, extractJsonLdBlocks, findJobPosting } from "@/lib/channels/web/embedded";
import { fetchHtml, missingDataError } from "@/lib/channels/web/page";
import { redactJobText } from "@/lib/channels/web/redact";
import { createTitleFilter, interleave, isWithinWindow, parseDate, slugify, windowCutoff } from "@/lib/channels/web/select";

import { htmlResponse, makeContext } from "./helpers";

describe("extractJsonAfter", () => {
  it("reads the object after a string anchor, ignoring braces and escaped quotes inside strings", () => {
    const html = `<script>window.state = {"a":"x } { \\" y","b":{"c":[1,2,{"d":null}]}}; var other = {"z":1};</script>`;
    expect(extractJsonAfter(html, "window.state =", "state")).toEqual({ a: 'x } { " y', b: { c: [1, 2, { d: null }] } });
  });

  it("reads bare undefined as null, but not inside strings or identifiers", () => {
    const html = `window.crate={"theme":undefined,"text":"undefined stays","list":[undefined,1],"isundefined":true};`;
    expect(extractJsonAfter(html, "window.crate=", "crate")).toEqual({ theme: null, text: "undefined stays", list: [null, 1], isundefined: true });
  });

  it("starts at the first brace after a regex anchor (a JS wrapper `{ props: {...} }` around the JSON)", () => {
    const html = `window.X = {\n  props: {"id": 7, "items": ["a"]}, hasDefaultProps: true\n};`;
    expect(extractJsonAfter(html, /window\.X\s*=\s*\{\s*props:/, "x")).toEqual({ id: 7, items: ["a"] });
  });

  it("returns null when the anchor is missing", () => {
    expect(extractJsonAfter("<html></html>", "window.state =", "state")).toBeNull();
    expect(extractJsonAfter("<html></html>", /nope/, "state")).toBeNull();
  });

  it("raises parse errors for cut-off or invalid data", () => {
    expect(() => extractJsonAfter(`window.s = {"a":{"b":1}`, "window.s =", "state")).toThrow(ChannelError);
    expect(() => extractJsonAfter(`window.s = {a: 1};`, "window.s =", "state")).toThrow(/not valid JSON/);
    expect(() => extractJsonAfter(`window.s = nothing`, "window.s =", "state")).toThrow(/no object/);
    try {
      extractJsonAfter(`window.s = {"a":`, "window.s =", "state");
    } catch (error) {
      expect(error).toMatchObject({ code: "parse" });
    }
  });
});

describe("JSON-LD", () => {
  const posting = { "@type": "JobPosting", title: "T" };

  it("reads blocks whatever the order of the script attributes, skipping broken ones", () => {
    const html = [
      `<script data-ch type="application/ld+json">${JSON.stringify(posting)}</script>`,
      `<script class="sp-graph-schema" type='application/ld+json'>{broken</script>`,
      `<script type="application/json">{"no":1}</script>`,
      `<script type="application/ld+json" class="x">{"@type":"WebPage"}</script>`,
    ].join("\n");
    expect(extractJsonLdBlocks(html)).toEqual([posting, { "@type": "WebPage" }]);
  });

  it("finds the JobPosting at the top level, in an array and in a graph", () => {
    expect(findJobPosting([posting])).toEqual(posting);
    expect(findJobPosting([[{ "@type": "WebPage" }, posting]])).toEqual(posting);
    expect(findJobPosting([{ "@graph": [{ "@type": "WebPage" }, posting] }])).toEqual(posting);
    expect(findJobPosting([{ "@type": ["Thing", "JobPosting"], title: "multi" }])).toMatchObject({ title: "multi" });
    expect(findJobPosting([{ "@type": "WebPage" }, "text", null])).toBeNull();
    expect(findJobPosting([])).toBeNull();
  });
});

describe("fetchHtml and missingDataError", () => {
  const settings = { max_results: 5 };

  it("sends the configured user agent and returns the body", async () => {
    const { ctx, calls } = makeContext(() => htmlResponse(200, "<html>ok</html>"), settings);
    await expect(fetchHtml(ctx, { url: "https://example.test/jobs", userAgent: "JobRadar/test" })).resolves.toBe("<html>ok</html>");
    expect(calls[0]?.headers["User-Agent"]).toBe("JobRadar/test");
    expect(calls[0]?.headers["Accept-Language"]).toMatch(/^de/);
  });

  it("returns null for pages that are gone", async () => {
    for (const status of [404, 410]) {
      const { ctx } = makeContext(() => htmlResponse(status, "gone"), settings);
      await expect(fetchHtml(ctx, { url: "https://example.test/x", userAgent: "ua" })).resolves.toBeNull();
    }
  });

  it("classifies 403 as blocked and 429 as rate_limited (no retry at maxRetries 0)", async () => {
    const blocked = makeContext(() => htmlResponse(403, "<title>Access denied</title>"), settings);
    await expect(fetchHtml(blocked.ctx, { url: "https://example.test/x", userAgent: "ua" })).rejects.toMatchObject({ code: "blocked", retryable: false });
    expect(blocked.calls).toHaveLength(1);
    const limited = makeContext(() => htmlResponse(429, "slow down"), settings);
    await expect(fetchHtml(limited.ctx, { url: "https://example.test/x", userAgent: "ua" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("tells a verification page from a layout change", () => {
    expect(missingDataError("<h1>Please verify you are a human</h1>", "h", "the state")).toMatchObject({ code: "blocked", retryable: false });
    expect(missingDataError("<h1>Jobs</h1>", "h", "the state")).toMatchObject({ code: "parse" });
  });
});

describe("selection helpers", () => {
  const settings = { enabled: true, include_terms: ["AI", "Machine Learning"], exclude_terms: ["Werkstudent", "Intern"] };

  it("keeps titles with a query keyword or include term, drops excluded ones, whole words only", () => {
    const keep = createTitleFilter(settings, ["Forward Deployed Engineer", "KI-Entwickler"]);
    expect(keep("Senior Forward Deployed Engineer (m/w/d)")).toBe(true);
    expect(keep("KI Entwickler Python")).toBe(true);
    expect(keep("Applied AI Lead")).toBe(true);
    expect(keep("Machine Learning Platform Engineer")).toBe(true);
    expect(keep("Backend Engineer Kotlin")).toBe(false);
    expect(keep("Bauingenieur / Architekt")).toBe(false);
    expect(keep("MAINTAINER Tools")).toBe(false); // "AI" inside a word does not count
    expect(keep("AI Werkstudent (m/w/d)")).toBe(false);
    expect(keep("Internal Tools AI Engineer")).toBe(true); // "Intern" is not a whole word here
  });

  it("keeps everything when disabled", () => {
    expect(createTitleFilter({ ...settings, enabled: false }, ["x"])("Garten-Landschaftsbauer")).toBe(true);
  });

  it("computes the window from now", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const cutoff = windowCutoff(now, 10);
    expect(cutoff.toISOString()).toBe("2026-10-07T02:00:00.000Z");
    expect(isWithinWindow(new Date("2026-10-07T02:00:00Z"), cutoff)).toBe(true);
    expect(isWithinWindow(new Date("2026-10-07T01:59:59Z"), cutoff)).toBe(false);
    expect(isWithinWindow(null, cutoff)).toBe(true);
  });

  it("parses dates leniently", () => {
    expect(parseDate("2026-10-07T01:39:42+02:00")?.toISOString()).toBe("2026-10-06T23:39:42.000Z");
    expect(parseDate("not a date")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("interleaves lists without duplicates up to the limit", () => {
    const id = (s: string): string => s;
    expect(interleave([["a", "b", "c"], ["a", "x"], ["y", "z"]], 10, id)).toEqual(["a", "y", "b", "x", "z", "c"]);
    expect(interleave([["a", "b", "c"], ["x", "y"]], 3, id)).toEqual(["a", "x", "b"]);
    expect(interleave([], 3, id)).toEqual([]);
  });

  it("makes URL slugs", () => {
    expect(slugify("AI Engineer")).toBe("ai-engineer");
    expect(slugify("KI-Entwickler")).toBe("ki-entwickler");
    expect(slugify(" München ")).toBe("münchen");
    expect(slugify("C++ / Rust (m/w/d)")).toBe("c-rust-m-w-d");
    expect(slugify("---")).toBe("");
  });
});

describe("per-cycle cache", () => {
  it("is shared within a signal and separate between signals", () => {
    const cacheFor = createCycleCache<number>();
    const a = new AbortController();
    const b = new AbortController();
    cacheFor(a.signal).set("k", 1);
    expect(cacheFor(a.signal).get("k")).toBe(1);
    expect(cacheFor(b.signal).has("k")).toBe(false);
  });
});

describe("redactJobText", () => {
  it("removes addresses, numbers and the whole contact line, and the name line above a number", () => {
    const text = [
      "Dein Kontakt",
      "Dr. Erika Musterfrau",
      "erika.musterfrau@example.test",
      "Team Data Science",
      "",
      "Ruf an unter +49 30 1234567-89 oder schreib an hr@example.test, wir antworten schnell.",
      "Wir freuen uns auf deine Bewerbung und bieten 30 Urlaubstage.",
    ].join("\n");
    const out = redactJobText(text);
    expect(out).not.toMatch(/@example|1234567|Musterfrau/);
    expect(out).toContain("Wir freuen uns auf deine Bewerbung und bieten 30 Urlaubstage.");
    expect(out).toContain("Dein Kontakt");
  });

  it("keeps long paragraphs that only mention an address", () => {
    const paragraph = `${"Bitte lies unsere Hinweise zur Bewerbung sorgfältig. ".repeat(4)}Fragen an jobs@example.test.`;
    expect(redactJobText(paragraph)).toContain("[email removed]");
    expect(redactJobText(paragraph)).toContain("Hinweise zur Bewerbung");
  });
});
