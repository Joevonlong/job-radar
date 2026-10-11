import { describe, expect, it } from "vitest";

import { buildHistory, diffYaml } from "@/lib/profile/view";
import type { ProfileSnapshot } from "@/lib/db";

describe("diffYaml", () => {
  it("shows changed lines with one line of context and gaps between hunks", () => {
    const before = ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6", "g: 7", ""].join("\n");
    const after = ["a: 1", "b: 20", "c: 3", "d: 4", "e: 5", "f: 60", "g: 7", ""].join("\n");
    const diff = diffYaml(before, after);
    expect(diff).toEqual([
      { type: "context", text: "a: 1" },
      { type: "del", text: "b: 2" },
      { type: "add", text: "b: 20" },
      { type: "context", text: "c: 3" },
      { type: "gap", text: "" },
      { type: "context", text: "e: 5" },
      { type: "del", text: "f: 6" },
      { type: "add", text: "f: 60" },
      { type: "context", text: "g: 7" },
    ]);
  });

  it("is empty for identical text", () => {
    expect(diffYaml("a: 1\n", "a: 1\n")).toEqual([]);
  });
});

function snapshot(id: number, yaml: string, hash: string, minute: number): ProfileSnapshot {
  return { id, kind: "me", contentYaml: yaml, hash, savedAt: new Date(Date.UTC(2026, 9, 7, 10, minute)) };
}

describe("buildHistory", () => {
  it("diffs every entry against the next older one and flags the current file", () => {
    const rows = [snapshot(3, "a: 3\n", "h3", 30), snapshot(2, "a: 2\n", "h2", 20), snapshot(1, "a: 1\n", "h1", 10)];
    const history = buildHistory(rows, "h3");
    expect(history.map((h) => [h.id, h.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(history[0]?.diff).toEqual([
      { type: "del", text: "a: 2" },
      { type: "add", text: "a: 3" },
    ]);
    expect(history[2]?.diff).toBeNull();
    expect(history[0]?.savedAt).toBe("2026-10-07T10:30:00.000Z");
  });

  it("respects the limit but still diffs the last visible entry against the hidden one", () => {
    const rows = [snapshot(2, "a: 2\n", "h2", 20), snapshot(1, "a: 1\n", "h1", 10)];
    const history = buildHistory(rows, null, 1);
    expect(history).toHaveLength(1);
    expect(history[0]?.diff).not.toBeNull();
    expect(history[0]?.current).toBe(false);
  });
});
