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

  it("never carries the value of a protected key, and masks the credentials of URLs in the others", () => {
    const ai = shippedValue("ai");
    const entries = overlayEntries("ai", ai, overlay("providers:\n  claude_cli:\n    command: /opt/secret-path/claude\n  deepseek:\n    base_url: https://user:pass@example.com/v1\n    model: https://user:pass@host.example/x\n"));
    const shown = JSON.stringify(entries);
    expect(shown).not.toContain("secret-path");
    expect(shown).not.toContain("user:pass");
    expect(entries.find((e) => e.path === "providers.claude_cli.command")).toMatchObject({ protected: true, shown: null });
    expect(entries.find((e) => e.path === "providers.deepseek.base_url")).toMatchObject({ protected: true, shown: null });
    expect(entries.find((e) => e.path === "providers.deepseek.model")?.shown).toBe('"https://***:***@host.example/x"');
  });

  it("an empty overlay or none has no entries", () => {
    expect(overlayEntries("schedule", shipped, {})).toEqual([]);
    expect(overlayEntries("schedule", shipped, null)).toEqual([]);
  });
});

describe("changedDefaults", () => {
  it("lists added, removed and changed leaves, protected keys without values", () => {
    const before = { a: { x: 1, y: [1, 2] }, gone: true, providers: { p: { command: "claude" } } };
    const after = { a: { x: 2, y: [1, 2], z: "new" }, providers: { p: { command: "other" } }, fresh: 1 };
    const changes = changedDefaults("ai", before, after);
    expect(changes.map((c) => [c.path, c.change, c.protected, c.before, c.after])).toEqual([
      ["a.x", "changed", false, "1", "2"],
      ["a.z", "added", false, null, '"new"'],
      ["fresh", "added", false, null, "1"],
      ["gone", "removed", false, "true", null],
      ["providers.p.command", "changed", true, null, null],
    ]);
  });

  it("is empty for equal values, however the keys are ordered", () => {
    expect(changedDefaults("schedule", { a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toEqual([]);
  });
});
