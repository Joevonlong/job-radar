// @vitest-environment node
import { describe, expect, it } from "vitest";

import { MAX_PATTERN_LENGTH, MAX_ROBOTS_RULES, parseRobots, patternMatches, productToken } from "@/lib/pipeline/robots";

const UA = "JobRadar/2 (self-hosted job tracker; link check)";

describe("robots.txt", () => {
  it("names our crawler by the product token of the User-Agent", () => {
    expect(productToken(UA)).toBe("jobradar");
  });

  it("uses the * group when none names us; an empty file or an empty Disallow allows everything", () => {
    const robots = parseRobots("User-agent: *\nDisallow: /private/\n", UA);
    expect(robots.allows("/jobs/1")).toBe(true);
    expect(robots.allows("/private/x")).toBe(false);
    expect(parseRobots("", UA).allows("/anything")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow:\n", UA).allows("/anything")).toBe(true);
  });

  it("prefers the group that names us over *", () => {
    const text = "User-agent: *\nDisallow: /\n\nUser-agent: jobradar\nAllow: /jobs/\nDisallow: /\n";
    const robots = parseRobots(text, UA);
    expect(robots.allows("/jobs/42")).toBe(true);
    expect(robots.allows("/admin")).toBe(false);
    // another crawler's group does not apply to us
    expect(parseRobots("User-agent: Googlebot\nDisallow: /\n", UA).allows("/jobs/1")).toBe(true);
  });

  it("the longest rule wins and Allow wins a tie; * and $ work; comments and case are ignored", () => {
    const text = ["# comment", "USER-AGENT: *", "Disallow: /jobs/", "Allow: /jobs/*/view$", "Disallow: /*.pdf$", "Allow: /jobs/", ""].join("\n");
    const robots = parseRobots(text, UA);
    expect(robots.allows("/jobs/1/view")).toBe(true);
    expect(robots.allows("/jobs/1/view/more")).toBe(true); // the tie on "/jobs/" goes to Allow
    expect(robots.allows("/files/a.pdf")).toBe(false);
    expect(robots.allows("/files/a.pdf?x=1")).toBe(true);
  });

  it("several user-agent lines share one group", () => {
    const robots = parseRobots("User-agent: foo\nUser-agent: *\nDisallow: /careers\n", UA);
    expect(robots.allows("/careers/7")).toBe(false);
  });

  it("matches a group only by the exact product token", () => {
    expect(parseRobots("User-agent: JobRadar/1.0\nDisallow: /\n", UA).allows("/jobs/1")).toBe(false);
    // "job" or "radar" are other crawlers' names, not ours
    expect(parseRobots("User-agent: job\nDisallow: /\n", UA).allows("/jobs/1")).toBe(true);
    expect(parseRobots("User-agent: radar\nDisallow: /\n", UA).allows("/jobs/1")).toBe(true);
  });

  it("globs: runs of * are one, $ anchors the end, matching is leftmost and linear", () => {
    expect(patternMatches("/a**b", "/a-x-b")).toBe(true);
    expect(patternMatches("/*/view$", "/jobs/1/view")).toBe(true);
    expect(patternMatches("/*/view$", "/jobs/1/view/2")).toBe(false);
    expect(patternMatches("/*b*b$", "/ab")).toBe(false);
    expect(patternMatches("/*b*b$", "/abb")).toBe(true);
    expect(patternMatches("/x$", "/x")).toBe(true);
    expect(patternMatches("/x$", "/xy")).toBe(false);
    expect(patternMatches("/*", "/")).toBe(true);
  });

  it("a pattern with many wildcards against a long path finishes at once (no backtracking)", () => {
    const pattern = `/${"*a".repeat(15)}*b$`;
    const robots = parseRobots(`User-agent: *\nDisallow: ${pattern}\n`, UA);
    const path = `/${"a".repeat(5000)}`;
    const started = performance.now();
    expect(robots.allows(path)).toBe(true);
    expect(patternMatches(pattern, path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("a group that applies to us and goes over the caps fails closed: nothing may be fetched", () => {
    const many = ["User-agent: *", ...Array.from({ length: MAX_ROBOTS_RULES + 1 }, (_, i) => `Allow: /r${i}/`)].join("\n");
    expect(parseRobots(many, UA).allows("/r0/x")).toBe(false);
    expect(parseRobots(many, UA).allows("/anything")).toBe(false);
    const ours = ["User-agent: jobradar", ...Array.from({ length: MAX_ROBOTS_RULES + 1 }, (_, i) => `Allow: /r${i}/`), "", "User-agent: *", "Allow: /"].join("\n");
    expect(parseRobots(ours, UA).allows("/r0/x")).toBe(false);
    const long = parseRobots(`User-agent: *\nAllow: /\nDisallow: /${"x".repeat(MAX_PATTERN_LENGTH)}\n`, UA);
    expect(long.allows("/jobs/1")).toBe(false);
    // exactly at the cap is still read
    const atCap = ["User-agent: *", ...Array.from({ length: MAX_ROBOTS_RULES - 1 }, (_, i) => `Disallow: /r${i}/`), "Allow: /"].join("\n");
    expect(parseRobots(atCap, UA).allows("/jobs/1")).toBe(true);
    expect(parseRobots(atCap, UA).allows("/r7/x")).toBe(false);
  });

  it("other crawlers' rules are not counted: thousands of them before `*` / Disallow: / still disallow (LinkedIn-shaped)", () => {
    // ~75 named groups with ~4,700 rules, then the catch-all group that forbids everything (the shape of linkedin.com/robots.txt)
    const named = Array.from({ length: 75 }, (_, g) => [`User-agent: Bot${g}`, ...Array.from({ length: 63 }, (_, i) => `Disallow: /area${i}/`), "Allow: /jobs/", ""].join("\n"));
    const text = [...named, "User-agent: *", "Disallow: /", "", "# notice"].join("\n");
    const robots = parseRobots(text, UA);
    expect(robots.allows("/jobs/view/123")).toBe(false);
    expect(robots.allows("/")).toBe(false);
    // and one of the named bots still gets its own rules
    expect(parseRobots(text, "Bot3/1.0").allows("/jobs/view/123")).toBe(true);
  });

  it("a long catch-all group under the cap answers rule by rule (Indeed-shaped)", () => {
    const wildcards = ["rt=nc", "&alid=", "&calert=", "&mna=", "?rss", "&serpstart=", "sid=", "&start="].map((p) => `Disallow: /*${p}`);
    const pages = Array.from({ length: 320 }, (_, i) => `Disallow: /section-${i}/`);
    const star = ["User-agent: *", "Allow: /", ...[0, 10, 20, 30, 40, 50].map((n) => `Allow: /*&start=${n}&`), ...wildcards, "Disallow: /viewjob", "Disallow: /advanced_search", "Disallow: /cmp/*/people", ...pages];
    const others = ["User-agent: Googlebot", ...Array.from({ length: 170 }, (_, i) => `Disallow: /g${i}/`), "", "User-agent: GPTBot", "Disallow: /"];
    const robots = parseRobots([...star, "", ...others].join("\n"), UA);
    expect(star.length - 1).toBeGreaterThan(330);
    expect(robots.allows("/")).toBe(true);
    expect(robots.allows("/cmp/Acme")).toBe(true);
    expect(robots.allows("/viewjob?jk=abc")).toBe(false);
    expect(robots.allows("/advanced_search")).toBe(false);
    expect(robots.allows("/cmp/Acme/people")).toBe(false);
    expect(robots.allows("/jobs?q=x&mna=1")).toBe(false);
    expect(robots.allows("/jobs?q=x&start=10&l=y")).toBe(true);
    expect(robots.allows("/jobs?q=x&start=70")).toBe(false);
    expect(robots.allows("/section-319/a")).toBe(false);
  });
});
