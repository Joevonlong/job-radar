// @vitest-environment node
import { describe, expect, it } from "vitest";

import { diffConfigs, maskCredentialsInText, maskProxyCredentials, parseImportText, planImport, planRepairImport, type ImportPlan } from "@/lib/sources/registry/import";

import { shippedChannels } from "../channels/helpers";

const current = shippedChannels();
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

function ok(plan: ImportPlan): Extract<ImportPlan, { ok: true }> {
  if (!plan.ok) throw new Error(`plan failed: ${JSON.stringify(plan.errors)}`);
  return plan;
}

describe("parseImportText", () => {
  it("rejects a file over the size limit before parsing it", () => {
    const result = parseImportText("a: 1\n".repeat(100), "yaml", 50);
    expect(result).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining("too large") }] });
  });

  it("reports YAML and JSON syntax errors without echoing the file", () => {
    const yaml = parseImportText("a: [1, 2\nb: secret-value", "yaml", 10_000);
    expect(yaml.ok).toBe(false);
    expect(JSON.stringify(yaml)).not.toContain("secret-value");
    const json = parseImportText('{"a": secret-value}', "json", 10_000);
    expect(json.ok).toBe(false);
    expect(JSON.stringify(json)).not.toContain("secret-value");
    expect(parseImportText("  \n", "yaml", 10_000).ok).toBe(false);
  });

  it("names a YAML syntax position once, with a code and its numbers", () => {
    const yaml = parseImportText("a: 1\nb:\n  - x\n c: [", "yaml", 10_000);
    expect(yaml.ok).toBe(false);
    const issue = !yaml.ok ? yaml.errors[0] : undefined;
    expect(issue).toMatchObject({ code: "invalid_yaml_at", values: { line: expect.any(Number), col: expect.any(Number) } });
    expect(String(issue?.values?.reason)).not.toMatch(/at line \d+, column \d+/);
    expect(issue?.message).toMatch(/^line \d+, column \d+: /);
    expect(issue?.message).not.toMatch(/at line/);
    expect(parseImportText("{", "json", 100)).toMatchObject({ ok: false, errors: [{ code: expect.stringMatching(/^invalid_json/) }] });
    expect(parseImportText("a: 1\n".repeat(600), "yaml", 2048)).toMatchObject({ ok: false, errors: [{ code: "too_large", values: { limit: 2 } }] });
  });

  it("parses both formats", () => {
    expect(parseImportText("a: 1\n", "yaml", 100)).toEqual({ ok: true, value: { a: 1 } });
    expect(parseImportText('{"a":1}', "json", 100)).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("planImport: replace", () => {
  it("is empty for the current config, and for its JSON export (zero diff)", () => {
    const same = ok(planImport(current, plain(current), "replace"));
    expect(same.changes).toEqual([]);
    const exported = JSON.parse(JSON.stringify(maskProxyCredentials(current))) as unknown;
    expect(ok(planImport(current, exported, "replace")).changes).toEqual([]);
  });

  it("lists a switched-off channel, a parameter change and an other-settings change with a summary", () => {
    const edited = plain(current) as { sources: { indeed: { enabled: boolean }; greenhouse: { max_results: number } }; paid_total_monthly_budget_usd: number };
    edited.sources.indeed.enabled = false;
    edited.sources.greenhouse.max_results += 5;
    edited.paid_total_monthly_budget_usd += 1;
    const plan = ok(planImport(current, edited, "replace"));
    expect(plan.summary).toMatchObject({ channelsDisabled: 1, channelsEnabled: 0, paramsChanged: 1, otherChanged: 1 });
    expect(plan.changes).toEqual(
      expect.arrayContaining([
        { group: "channel", target: "indeed", kind: "disabled" },
        expect.objectContaining({ group: "channel", target: "greenhouse", kind: "param", path: "max_results" }),
        expect.objectContaining({ group: "other", target: "paid_total_monthly_budget_usd", from: "15", to: "16" }),
      ]),
    );
  });

  it("counts added, removed and changed boards", () => {
    const edited = plain(current) as { ats_boards: Array<{ name: string; ats: string; token: string; enabled: boolean }> };
    edited.ats_boards = edited.ats_boards.slice(1);
    const second = edited.ats_boards[0];
    if (second) second.enabled = !second.enabled;
    edited.ats_boards.push({ name: "Newco", ats: "ashby", token: "newco", enabled: true });
    const plan = ok(planImport(current, edited, "replace"));
    expect(plan.summary).toMatchObject({ boardsAdded: 1, boardsRemoved: 1, boardsChanged: 1 });
    expect(plan.changes.filter((c) => c.group === "board").map((c) => c.kind).sort()).toEqual(["added", "changed", "removed"]);
  });

  it("always keeps the current jobspy.proxies, whatever the file says", () => {
    const withProxies = { ...current, jobspy: { ...current.jobspy, proxies: ["http://user:pw@proxy.example:8080"] } };
    const edited = plain(withProxies) as { jobspy: { proxies: string[] } };
    edited.jobspy.proxies = ["http://***:***@proxy.example:8080", "http://other"];
    const plan = ok(planImport(withProxies, edited, "replace"));
    expect(plan.next.jobspy.proxies).toEqual(["http://user:pw@proxy.example:8080"]);
    expect(plan.notes).toContainEqual({ key: "proxiesKept" });
    expect(plan.changes).toEqual([]);
  });

  it("reports schema errors with their paths", () => {
    const bad = plain(current) as { sources: { indeed: { max_results: number } } };
    bad.sources.indeed.max_results = -1;
    const plan = planImport(current, bad, "replace");
    expect(plan).toMatchObject({ ok: false });
    expect(plan.ok ? [] : plan.errors.map((e) => e.path)).toContain("sources.indeed.max_results");
    expect(planImport(current, ["x"], "replace").ok).toBe(false);
  });
});

describe("import schema errors are codes and name the company", () => {
  const issues = (plan: ImportPlan) => (plan.ok ? [] : plan.errors);

  it("a bad board in a replace file is found by its name and token, not by its position", () => {
    const file = plain(current) as { ats_boards: Array<Record<string, unknown>> };
    file.ats_boards = [
      { name: "Fine Co", ats: "greenhouse", token: "fineco", enabled: true },
      { name: "Fahrwelle", ats: "greenhouse", token: "bad token!", enabled: true },
      { name: "Odd", ats: "workday", token: "odd", enabled: true },
      { name: "Typo", ats: "lever", token: "typo", enabled: "yes", extra: 1 },
    ];
    const found = issues(planImport(current, file, "replace"));
    const by = (path: string) => found.find((i) => i.path === path);
    expect(by("ats_boards[1].token")).toMatchObject({ code: "bad_token", target: "Fahrwelle (greenhouse/bad token!)" });
    expect(by("ats_boards[2].ats")).toMatchObject({ code: "invalid_value", target: "Odd (workday/odd)" });
    expect(by("ats_boards[3].enabled")).toMatchObject({ code: "wrong_type", values: { expected: "boolean" }, target: "Typo (lever/typo)" });
    expect(by("ats_boards[3].extra")).toMatchObject({ code: "unknown_key", target: "Typo (lever/typo)" });
  });

  it("a duplicate and an EU board outside Lever are named too", () => {
    const file = plain(current) as { ats_boards: Array<Record<string, unknown>> };
    file.ats_boards = [
      { name: "Fine Co", ats: "greenhouse", token: "fineco", enabled: true },
      { name: "Dup", ats: "greenhouse", token: "FINECO", enabled: true },
      { name: "Eu Co", ats: "ashby", token: "euco", enabled: true, region: "eu" },
    ];
    const found = issues(planImport(current, file, "replace"));
    expect(found.find((i) => i.path === "ats_boards[1].token")).toMatchObject({ code: "duplicate_board", target: "Dup (greenhouse/FINECO)" });
    expect(found.find((i) => i.path === "ats_boards[2].region")).toMatchObject({ code: "eu_lever_only", target: "Eu Co (ashby/euco)" });
  });

  it("numbers out of range and missing fields get codes with their limits", () => {
    const bad = plain(current) as { sources: { indeed: { max_results: number | undefined } }; ats_boards: Array<Record<string, unknown>> };
    bad.sources.indeed.max_results = -1;
    bad.ats_boards = [{ ats: "lever", token: "x", enabled: true }];
    const found = issues(planImport(current, bad, "replace"));
    expect(found.find((i) => i.path === "sources.indeed.max_results")).toMatchObject({ code: "too_small", values: { origin: "number", limit: 0, inclusive: "false" } });
    expect(found.find((i) => i.path === "ats_boards[0].name")).toMatchObject({ code: "required", target: "lever/x" });
  });

  it("a merge file names its companies too", () => {
    const found = issues(planImport(current, { ats_boards: [{ name: "Merge Co", ats: "lever", token: "no good", enabled: true }] }, "merge_boards"));
    expect(found[0]).toMatchObject({ path: "ats_boards[0].token", code: "bad_token", target: "Merge Co (lever/no good)" });
  });
});

describe("planImport: merge_boards", () => {
  it("adds new boards, updates name / enabled / region of known ones, deletes nothing and ignores other keys", () => {
    const known = current.ats_boards[0];
    if (!known) throw new Error("no boards");
    const file = { ats_boards: [{ ...known, name: "Renamed", enabled: !known.enabled }, { name: "Newco", ats: "ashby", token: "NewCo", enabled: true }], paid_total_monthly_budget_usd: 99, sources: {} };
    const plan = ok(planImport(current, file, "merge_boards"));
    expect(plan.next.ats_boards).toHaveLength(current.ats_boards.length + 1);
    expect(plan.next.ats_boards[0]).toMatchObject({ name: "Renamed", token: known.token });
    expect(plan.next.ats_boards.at(-1)).toMatchObject({ token: "NewCo" });
    expect(plan.next.paid_total_monthly_budget_usd).toBe(current.paid_total_monthly_budget_usd);
    expect(plan.notes).toContainEqual({ key: "ignoredKeys", count: 2 });
    expect(plan.summary).toMatchObject({ boardsAdded: 1, boardsRemoved: 0, boardsChanged: 1 });
  });

  it("accepts the list of an old companies.yaml, matching tokens case-insensitively", () => {
    const known = current.ats_boards.find((b) => b.ats === "greenhouse");
    if (!known) throw new Error("no greenhouse board");
    const plan = ok(planImport(current, { companies: [{ name: known.name, ats: "greenhouse", token: known.token.toUpperCase(), enabled: false }] }, "merge_boards"));
    expect(plan.next.ats_boards).toHaveLength(current.ats_boards.length);
    expect(plan.summary.boardsChanged).toBe(known.enabled ? 1 : 0);
  });

  it("refuses a file without a board list and a list with a bad entry", () => {
    expect(planImport(current, { sources: {} }, "merge_boards").ok).toBe(false);
    const plan = planImport(current, { ats_boards: [{ name: "X", ats: "workday", token: "x", enabled: true }] }, "merge_boards");
    expect(plan.ok ? [] : plan.errors.map((e) => e.path)).toContain("ats_boards[0].ats");
  });
});

describe("planRepairImport", () => {
  it("takes a complete file when the current one is unreadable and keeps the salvaged proxies", () => {
    const file = plain(current) as { jobspy: { proxies: string[] } };
    file.jobspy.proxies = ["x"];
    const plan = ok(planRepairImport(file, ["http://u:p@h:1"]));
    expect(plan.next.jobspy.proxies).toEqual(["http://u:p@h:1"]);
    expect(plan.notes).toContainEqual({ key: "repair" });
    expect(planRepairImport({}, []).ok).toBe(false);
  });
});

describe("credentials are masked", () => {
  it("in text and in the config", () => {
    expect(maskCredentialsInText("proxies:\n  - http://user:pw@proxy.example:8080\n  - socks5://a@h:1\n  - host:9")).toBe("proxies:\n  - http://***:***@proxy.example:8080\n  - socks5://***:***@h:1\n  - host:9");
    const masked = maskProxyCredentials({ ...current, jobspy: { ...current.jobspy, proxies: ["http://user:pw@p.example:1"] } });
    expect(masked.jobspy.proxies).toEqual(["http://***:***@p.example:1"]);
  });
});

describe("diffConfigs", () => {
  it("does not report the recommended side channel's block twice", () => {
    const next = { ...current, linkedin: { ...current.linkedin, session: { ...current.linkedin.session, recommended_max_results: current.linkedin.session.recommended_max_results + 1 } } };
    const { changes } = diffConfigs(current, next);
    expect(changes.filter((c) => c.kind === "param").map((c) => c.target)).toEqual(["linkedin-session"]);
  });

  it("shows a list change without its values", () => {
    const next = { ...current, linkedin: { ...current.linkedin, cascade: [...current.linkedin.cascade].reverse() } };
    expect(diffConfigs(current, next).changes).toEqual([{ group: "other", target: "linkedin.cascade", kind: "param", path: "linkedin.cascade" }]);
  });
});
