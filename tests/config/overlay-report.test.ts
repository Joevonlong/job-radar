// @vitest-environment node
import { describe, expect, it } from "vitest";

import { changedDefaults, countOverlayEntries, overlayEntries } from "@/lib/config/overlay-report";

import { overlay, shippedValue } from "./overlay-helpers";

describe("overlayEntries", () => {
  const shipped = shippedValue("schedule");
  const keep = (shipped as { backup: { keep_daily: number } }).backup.keep_daily;

  it("counts overrides, unsets and pins, and flags an unset of a key the shipped file lacks", () => {
    const entries = overlayEntries(
      "schedule",
      shipped,
      overlay(`backup:\n  keep_daily: ${keep + 1}\n  keep_weekly: !unset\n  keep_weekly_typo: !unset\ncatch_up: ${(shipped as { catch_up: boolean }).catch_up}\n`),
    );
    expect(entries.map((e) => [e.path, e.kind, e.pin, e.invalid])).toEqual([
      ["backup.keep_daily", "override", false, false],
      ["backup.keep_weekly", "unset", false, false],
      ["backup.keep_weekly_typo", "unset", false, true],
      ["catch_up", "override", true, false],
    ]);
    expect(countOverlayEntries(entries)).toEqual({ overrides: 2, unsets: 2, pins: 1, invalidUnsets: 1 });
  });

  it("counts a list or a replaced record once, and a new entry of an entries record on its own", () => {
    const ai = shippedValue("ai");
    const entries = overlayEntries("ai", ai, overlay("translation:\n  glossary:\n    brand-new-term: neu\n"));
    expect(entries.map((e) => e.path)).toEqual(["translation.glossary.brand-new-term"]);
    const lists = overlayEntries("ai", ai, overlay("order: [a, b]\n"));
    expect(lists.map((e) => e.path)).toEqual(["order"]);
  });

  it("never carries the value of a protected key or of a value that holds one", () => {
    const ai = shippedValue("ai");
    const entries = overlayEntries("ai", ai, overlay("providers:\n  claude_cli:\n    command: /opt/secret-path/claude\n  deepseek:\n    base_url: https://user:pass@example.com/v1\n  brand_new:\n    base_url: https://leak.example/v1\n    model: m\n"));
    const shown = JSON.stringify(entries);
    for (const secret of ["secret-path", "user:pass", "leak.example"]) expect(shown).not.toContain(secret);
    expect(entries.find((e) => e.path === "providers.claude_cli.command")).toMatchObject({ protected: true, shown: null });
    expect(entries.find((e) => e.path === "providers.deepseek.base_url")).toMatchObject({ protected: true, shown: null });
    expect(entries.find((e) => e.path === "providers.brand_new")).toMatchObject({ protected: true, shown: null });
  });

  it("covers a whole record that holds a protected key, and a type mismatch under one", () => {
    const channels = shippedValue("channels");
    const entries = overlayEntries("channels", channels, overlay("linkedin:\n  apify:\n    input_template:\n      base_url: https://leak.example\n  session: https://leak2.example\njobspy:\n  proxies: [http://u:p@h]\n"));
    expect(JSON.stringify(entries)).not.toMatch(/leak|u:p/);
    expect(entries.every((e) => e.shown === null || !/leak/.test(e.shown))).toBe(true);
  });

  it("shows numbers, booleans and short plain strings; everything else only its shape", () => {
    const ai = shippedValue("ai");
    const shown = (text: string): string | null => overlayEntries("ai", ai, overlay(text))[0]?.shown ?? null;
    expect(shown("timeout: 61\n")).toBe("61");
    expect(shown("flag: true\n")).toBe("true");
    expect(shown("name: fast\n")).toBe('"fast"');
    expect(shown("public_base_url: https://example.com/x\n")).toBe("(string, 21 chars)");
    expect(shown("order: [a, b, c]\n")).toBe("(list, 3 items)");
    expect(shown("one: [a]\n")).toBe("(list, 1 item)");
    expect(shown("block: {a: 1, b: 2}\n")).toBe("(map, 2 keys)");
    expect(shown("translation:\n  glossary:\n    term: AKIAIOSFODNN7EXAMPLE\n")).toBe("(string, 20 chars)");
    expect(shown("t: sk-abc\n")).toBe("(string, 6 chars)");
    expect(shown("t: ghp_x\n")).toBe("(string, 5 chars)");
    expect(shown("t: xoxb-1\n")).toBe("(string, 6 chars)");
    expect(shown(`t: ${"a".repeat(22)}\n`)).toBe("(string, 22 chars)");
    expect(shown(`t: ${"word ".repeat(10).trim()}\n`)).toBe("(string, 49 chars)");
  });

  it("an empty overlay or none has no entries", () => {
    expect(overlayEntries("schedule", shipped, {})).toEqual([]);
    expect(overlayEntries("schedule", shipped, null)).toEqual([]);
  });
});

describe("changedDefaults", () => {
  it("lists added, removed and changed leaves with real values, protected keys without", () => {
    const before = { a: { x: 1, y: [1, 2] }, gone: true, providers: { p: { command: "claude" } } };
    const after = { a: { x: 2, y: [1, 2], z: "https://example.com" }, providers: { p: { command: "other" } }, fresh: 1 };
    const changes = changedDefaults("ai", before, after);
    expect(changes.map((c) => [c.path, c.change, c.protected, c.before, c.after])).toEqual([
      ["a.x", "changed", false, 1, 2],
      ["a.z", "added", false, null, "https://example.com"],
      ["fresh", "added", false, null, 1],
      ["gone", "removed", false, true, null],
      ["providers.p.command", "changed", true, null, null],
    ]);
  });

  it("summarises a changed list by its added and removed items", () => {
    const [change] = changedDefaults("search", { l: ["a", "b"] }, { l: ["b", "c"] });
    expect(change).toMatchObject({ path: "l", change: "changed", before: ["a", "b"], after: ["b", "c"], summary: 'added ["c"]; removed ["a"]' });
  });

  it("keeps a protected list out even when the list changed", () => {
    const [change] = changedDefaults("salary", { lookup: { allowed_fetch_domains: ["a.com"] } }, { lookup: { allowed_fetch_domains: ["a.com", "b.com"] } });
    expect(change).toMatchObject({ protected: true, before: null, after: null, summary: null });
  });

  it("is empty for equal values, however the keys are ordered", () => {
    expect(changedDefaults("schedule", { a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toEqual([]);
  });
});
