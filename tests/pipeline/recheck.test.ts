// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createHttpClient, type FetchLike } from "@/lib/channels/http";
import { classifyPage, combineChecks, compilePhrases, createWatchedChecker, MAX_SEARCHED_CHARS, PHRASE_BUDGET_MS, QUOTE_MAX, visiblePageText, type PageCheck } from "@/lib/pipeline/recheck";

// the phrases of this test (the packs ship their own lists; tests never read config/*.yaml values)
const EN = compilePhrases(["no longer accepting applications", "this (job|position|posting|role) (is )?no longer available", "(job|position|posting) has (been )?(closed|expired|filled)"]);
const DE = compilePhrases(["nicht mehr verfügbar", "Stelle (ist )?(bereits )?(besetzt|vergeben)", "Bewerbungs(phase|frist) (ist )?(beendet|abgelaufen)"]);
const page = (body: string) => `<!doctype html><html><head><title>Job</title><script>var s = "no longer accepting applications";</script></head><body>${body}</body></html>`;

describe("classifyPage: English", () => {
  it.each([
    ["a banner", page("<main><h1>ML Engineer</h1><div class='banner'>This position is no longer accepting applications.</div></main>")],
    ["the job is no longer available", page("<main><p>Sorry, this job is no longer available.</p></main>")],
    ["the posting has expired", page("<main><h2>Data Engineer</h2><p>This posting has expired. Browse other roles.</p></main>")],
  ])("finds the phrase in %s", (_name, html) => {
    const result = classifyPage(200, html, EN);
    expect(result.outcome).toBe("phrase");
    expect(result.quote).not.toBeNull();
    expect(result.quote!.length).toBeLessThanOrEqual(QUOTE_MAX);
  });

  it.each([
    ["only in a script", page("<main><h1>ML Engineer</h1><p>Apply now.</p></main>")],
    ["only in a hidden element", page("<main><p>Apply now.</p><div style='display:none'>No longer accepting applications</div><p hidden>This job is no longer available</p></main>")],
    ["only in the sidebar of other jobs", page("<main><p>We are hiring an ML engineer. Apply now.</p></main><aside><h3>Other jobs</h3><p>Data Engineer: this posting has expired</p></aside>")],
  ])("does not count a phrase %s", (_name, html) => {
    expect(classifyPage(200, html, EN).outcome).toBe("alive");
  });
});

describe("classifyPage: German", () => {
  it.each([
    ["nicht mehr verfügbar", page("<main><p>Diese Stellenanzeige ist leider nicht mehr verfügbar.</p></main>")],
    ["Stelle besetzt", page("<main><h1>Data Scientist (m/w/d)</h1><p>Diese Stelle ist bereits besetzt.</p></main>")],
    ["Bewerbungsfrist abgelaufen", page("<main><p>Die Bewerbungsfrist ist abgelaufen.</p></main>")],
  ])("finds %s", (_name, html) => {
    expect(classifyPage(200, html, DE).outcome).toBe("phrase");
  });

  it.each([
    ["in a noscript", page("<main><p>Jetzt bewerben!</p><noscript>Diese Stelle ist bereits besetzt</noscript></main>")],
    ["in an aria-hidden element", page("<main><p>Jetzt bewerben!</p><span aria-hidden='true'>nicht mehr verfügbar</span></main>")],
    ["in the navigation", page("<nav>Archiv: Stelle vergeben</nav><main><p>Wir suchen Verstärkung. Jetzt bewerben!</p></main>")],
  ])("does not count one %s", (_name, html) => {
    expect(classifyPage(200, html, DE).outcome).toBe("alive");
  });
});

describe("classifyPage: status and evidence", () => {
  it("404 / 410 are gone, other errors unknown", () => {
    expect(classifyPage(404, "", EN).outcome).toBe("gone");
    expect(classifyPage(410, "", EN).outcome).toBe("gone");
    expect(classifyPage(403, page("no longer accepting applications"), EN).outcome).toBe("unknown");
    expect(classifyPage(500, "", EN).outcome).toBe("unknown");
  });

  it("keeps the phrase and a short quote around the match", () => {
    const filler = "x ".repeat(300);
    const result = classifyPage(200, page(`<p>${filler} Note: this role is no longer available, sorry. ${filler}</p>`), EN);
    expect(result.phrase).toContain("no longer available");
    expect(result.quote).toContain("this role is no longer available");
    expect(result.quote!.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(result.quote!.startsWith("…")).toBe(true);
  });

  it("reads only the visible text", () => {
    expect(visiblePageText(page("<p>Hello<br>world</p><template>secret</template><style>.a{}</style>"))).toBe("Hello world");
  });
});

describe("classifyPage: bounded search of the user's phrases", () => {
  it("searches only the first MAX_SEARCHED_CHARS of the visible text", () => {
    const html = page(`<p>${"z ".repeat(MAX_SEARCHED_CHARS)}</p><p>no longer accepting applications</p>`);
    expect(classifyPage(200, html, EN).outcome).toBe("alive");
  });

  it("a search that runs out of its time budget is unknown, not alive", () => {
    let t = 0;
    const clock = () => (t += PHRASE_BUDGET_MS);
    const phrases = compilePhrases(["first never matches", "second never matches", "no longer accepting applications"]);
    expect(classifyPage(200, page("<p>no longer accepting applications</p>"), phrases, clock).outcome).toBe("unknown");
  });
});

describe("combineChecks", () => {
  const c = (outcome: PageCheck["outcome"]): PageCheck => ({ outcome, httpStatus: null, phrase: null, quote: null, url: `https://x.test/${outcome}` });
  it("any live link keeps the job; all gone closes it; gone + phrase is a phrase; robots only is robots", () => {
    expect(combineChecks([c("gone"), c("alive")])?.outcome).toBe("alive");
    expect(combineChecks([c("gone"), c("gone")])?.outcome).toBe("gone");
    expect(combineChecks([c("gone"), c("phrase")])?.outcome).toBe("phrase");
    expect(combineChecks([c("robots")])?.outcome).toBe("robots");
    expect(combineChecks([c("gone"), c("unknown")])?.outcome).toBe("unknown");
    expect(combineChecks([])).toBeNull();
  });
});

describe("the watched checker: robots, throttle, size limit", () => {
  function setup(routes: Record<string, { status: number; body?: string } | "network">, perHostMinIntervalMs = 1000) {
    const calls: { url: string; at: number; ua: string | undefined }[] = [];
    let now = 0;
    const waits: number[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, at: now, ua: init.headers?.["user-agent"] });
      const route = routes[url];
      if (route === undefined || route === "network") throw new TypeError("fetch failed");
      const body = route.body ?? "";
      return { status: route.status, ok: route.status < 400, headers: { get: () => null }, text: async () => body, json: async () => ({}) };
    };
    const http = createHttpClient({ settings: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 }, fetch, sleep: async () => {} });
    const checker = createWatchedChecker(
      { userAgent: "JobRadar/2 (test)", timeoutMs: 1000, maxBodyBytes: 200, perHostMinIntervalMs, phrases: EN },
      {
        http,
        resolve: async () => ["93.184.216.34"],
        clock: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      },
    );
    return { checker, calls, waits };
  }

  it("asks robots.txt once per host, obeys it, and sends our User-Agent", async () => {
    const { checker, calls } = setup({
      "https://a.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private/\n" },
      "https://a.test/jobs/1": { status: 200, body: page("<p>Apply</p>") },
    });
    expect((await checker.checkPage("https://a.test/private/1")).outcome).toBe("robots");
    expect((await checker.checkPage("https://a.test/jobs/1")).outcome).toBe("alive");
    expect(calls.map((c) => c.url)).toEqual(["https://a.test/robots.txt", "https://a.test/jobs/1"]);
    expect(new Set(calls.map((c) => c.ua))).toEqual(new Set(["JobRadar/2 (test)"]));
  });

  it("a robots.txt that is missing allows; one that fails skips the host as unknown without fetching the page", async () => {
    const missing = setup({ "https://a.test/robots.txt": { status: 404 }, "https://a.test/jobs/1": { status: 410 } });
    expect((await missing.checker.checkPage("https://a.test/jobs/1")).outcome).toBe("gone");
    const failing = setup({ "https://b.test/robots.txt": { status: 503 }, "https://b.test/jobs/1": { status: 200 } });
    expect((await failing.checker.checkPage("https://b.test/jobs/1")).outcome).toBe("unknown");
    expect(failing.calls.map((c) => c.url)).toEqual(["https://b.test/robots.txt"]);
    const down = setup({ "https://c.test/robots.txt": "network" });
    expect((await down.checker.checkPage("https://c.test/jobs/1")).outcome).toBe("unknown");
  });

  it("waits per_host_min_interval_ms between two requests to one host, not between hosts", async () => {
    const { checker, calls, waits } = setup({
      "https://a.test/robots.txt": { status: 404 },
      "https://a.test/1": { status: 200, body: "ok" },
      "https://a.test/2": { status: 200, body: "ok" },
      "https://b.test/robots.txt": { status: 404 },
      "https://b.test/1": { status: 200, body: "ok" },
    });
    await checker.checkPage("https://a.test/1");
    await checker.checkPage("https://b.test/1");
    await checker.checkPage("https://a.test/2");
    const a = calls.filter((c) => c.url.startsWith("https://a.test"));
    for (let i = 1; i < a.length; i++) expect(a[i]!.at - a[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    expect(waits.length).toBeGreaterThan(0);
  });

  it("reads at most max_body_bytes without failing (a phrase after the limit is not seen)", async () => {
    const { checker } = setup({
      "https://a.test/robots.txt": { status: 404 },
      "https://a.test/1": { status: 200, body: page(`<p>${"y".repeat(400)} no longer accepting applications</p>`) },
    });
    expect((await checker.checkPage("https://a.test/1")).outcome).toBe("alive");
  });

  it("a timeout or network error is unknown", async () => {
    const { checker } = setup({ "https://a.test/robots.txt": { status: 404 }, "https://a.test/1": "network" });
    expect((await checker.checkPage("https://a.test/1")).outcome).toBe("unknown");
  });
});
