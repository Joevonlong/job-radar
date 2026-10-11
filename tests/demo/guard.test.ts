import { describe, expect, it, vi } from "vitest";

import { assertNoLeaks, buildForbiddenPatterns, findLeaks, guardedScreenshot, LeakError, realEmails, serializeDocument, TrafficLog, type GuardedPage, type MachineFacts } from "../../e2e-demo/guard";

// made-up machine facts (none of them exist on the test machine); the paths are built at run time so the release check's
// machine-path rule does not flag this file
const USERS = "/" + "Users/";
const VOLUMES = "/" + "Volumes/";
const TAILNET = ["box.tail1234", "ts", "net"].join(".");
const FACTS: MachineFacts = {
  homedir: `${USERS}zoltan-q`,
  username: "zoltan-q",
  hostname: "Quasar-Desk.local",
  tmpdir: "/var/folders/xy/zz123/T",
  repoRoot: `${VOLUMES}QuasarDrive/code/job-radar`,
};
const PATTERNS = buildForbiddenPatterns(FACTS, ["Ondine Wexford"]);
const labels = (text: string) => findLeaks(text, PATTERNS, "test").map((l) => l.label);

describe("leak guard patterns", () => {
  it.each([
    ["the home directory", `saved to ${USERS}zoltan-q/notes.yaml`, "home directory"],
    ["the user name as a word", "signed in as Zoltan-Q today", "user name"],
    ["the host name", "runner on quasar-desk is idle", "host name"],
    ["the host name with .local", "http://Quasar-Desk.local:3000/", "host name"],
    ["the temp directory", "wrote /var/folders/xy/zz123/T/cfg.yaml", "temp directory"],
    ["the macOS /private temp variant", "wrote /private/var/folders/xy/zz123/T/cfg.yaml", "temp directory"],
    ["the repository path", `from ${VOLUMES}QuasarDrive/code/job-radar/config`, "repository path"],
    ["a machine path", `see ${USERS}somebody/file`, "machine path"],
    ["a tailnet host", `https://${TAILNET}/`, "tailnet host name"],
    ["a real-style e-mail", "write to anna.berg@gmail.com", "e-mail address outside the fictional domains"],
    ["a private string", "by Ondine Wexford", "private string #1 of the patterns file"],
  ])("finds %s", (_name, text, label) => {
    expect(labels(text)).toContain(label);
  });

  it("lets fictional data through", () => {
    const text = `Mosaik Health AI · jobs@mosaik.example · hr@x.test · http://127.0.0.1:3000/jobs/4 · /tmp/job-radar-demo/config · ${USERS}me/x · icon@2x.png · a.example-tailnet.ts.net`;
    expect(findLeaks(text, PATTERNS, "test")).toEqual([]);
  });

  it("never repeats a private string in its report", () => {
    const [leak] = findLeaks("by Ondine Wexford", PATTERNS, "test");
    expect(leak?.excerpt).not.toContain("Ondine");
  });

  it("skips user names that are ordinary words", () => {
    const patterns = buildForbiddenPatterns({ ...FACTS, username: "demo" });
    expect(patterns.some((p) => p.label === "user name")).toBe(false);
  });

  it("ignores file names that look like e-mail addresses", () => {
    expect(realEmails("logo@2x.png font@latest.woff2")).toEqual([]);
  });
});

describe("serializeDocument", () => {
  it("includes title attributes and typed form values", () => {
    document.body.innerHTML = `<span title="${USERS}zoltan-q/cv.pdf">CV</span><input id="a"><textarea id="b"></textarea>`;
    (document.getElementById("a") as HTMLInputElement).value = "anna.berg@gmail.com";
    (document.getElementById("b") as HTMLTextAreaElement).value = "Ondine Wexford";
    const found = labels(serializeDocument());
    expect(found).toEqual(expect.arrayContaining(["home directory", "e-mail address outside the fictional domains", "private string #1 of the patterns file"]));
  });
});

describe("guardedScreenshot", () => {
  const fakePage = (markup: string): GuardedPage & { screenshot: ReturnType<typeof vi.fn> } => ({
    evaluate: async <R>() => markup as unknown as R,
    screenshot: vi.fn(async () => undefined),
  });

  it("writes no picture when the page leaks", async () => {
    const page = fakePage(`<p>${USERS}zoltan-q</p>`);
    await expect(guardedScreenshot(page, "x.png", PATTERNS)).rejects.toBeInstanceOf(LeakError);
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it("writes no picture when a loaded response leaks", async () => {
    const page = fakePage("<p>clean</p>");
    const traffic = new TrafficLog();
    traffic.add("response body of /api/x", '{"host":"quasar-desk"}');
    await expect(guardedScreenshot(page, "x.png", PATTERNS, traffic)).rejects.toBeInstanceOf(LeakError);
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it("takes a viewport picture of a clean page", async () => {
    const page = fakePage("<p>Mosaik Health AI</p>");
    await guardedScreenshot(page, "x.png", PATTERNS, new TrafficLog());
    expect(page.screenshot).toHaveBeenCalledWith({ path: "x.png", animations: "disabled", fullPage: false });
  });

  it("assertNoLeaks drains the traffic it checked", async () => {
    const traffic = new TrafficLog();
    traffic.add("request URL", "http://127.0.0.1:3190/");
    await assertNoLeaks({ evaluate: async <R>() => "" as unknown as R }, PATTERNS, traffic);
    expect(traffic.drain()).toEqual([]);
  });
});
