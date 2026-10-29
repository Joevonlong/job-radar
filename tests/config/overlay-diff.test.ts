import { describe, expect, it } from "vitest";

import { mergeLayers } from "@/lib/config/merge";
import { applyOverlayEdits, diffOverlay, repairOverlayEdits, type OverlayEdit } from "@/lib/config/overlay-diff";
import { replaceRule, type ReplaceAt } from "@/lib/config/overlay-rules";
import { UNSET } from "@/lib/config/yaml-options";

import { overlay } from "./overlay-helpers";

const SHIPPED = {
  timezone: "UTC",
  backup: { keep_daily: 7, keep_weekly: 4 },
  glossary: { A: "a", B: "b" },
  list: [1, 2],
  nullable: "set",
};

function save(current: unknown, value: unknown, replaceAt?: ReplaceAt, shipped: unknown = SHIPPED): { edits: OverlayEdit[]; next: unknown } {
  const edits = diffOverlay({ shipped, overlay: current, value, replaceAt });
  const next = applyOverlayEdits(current, edits);
  // the pinned-key rule always reads back to the saved value
  expect(mergeLayers(shipped, next, { replaceAt })).toEqual(value);
  return { edits, next };
}

function effectiveOf(current: unknown, replaceAt?: ReplaceAt): Record<string, unknown> {
  return mergeLayers(SHIPPED, current, { replaceAt }) as Record<string, unknown>;
}

describe("diffOverlay: only the paths where E and V differ are touched", () => {
  it("a save without a change gives no edits (the file stays byte for byte)", () => {
    const current = overlay("backup:\n  keep_daily: 7\nglossary:\n  A: !unset\n");
    expect(save(current, effectiveOf(current)).edits).toEqual([]);
    expect(save(undefined, structuredClone(SHIPPED)).edits).toEqual([]);
  });

  it("a value that differs from the shipped one is written", () => {
    const { edits, next } = save({}, { ...SHIPPED, backup: { keep_daily: 9, keep_weekly: 4 } });
    expect(edits).toEqual([{ op: "set", path: ["backup", "keep_daily"], value: 9 }]);
    expect(next).toEqual({ backup: { keep_daily: 9 } });
  });

  it("a value back to the shipped one leaves the overlay, and so does a mapping it empties", () => {
    const { edits, next } = save(overlay("backup:\n  keep_daily: 9\ntimezone: Europe/Berlin\n"), { ...SHIPPED, timezone: "Europe/Berlin" });
    expect(edits).toEqual([{ op: "remove", path: ["backup"] }]);
    expect(next).toEqual({ timezone: "Europe/Berlin" });
  });

  it("dropping a shipped entry writes !unset; dropping an entry only the overlay had removes it", () => {
    const current = overlay("glossary:\n  C: c\n");
    const { edits, next } = save(current, { ...SHIPPED, glossary: { B: "b" } });
    expect(edits).toEqual([
      { op: "unset", path: ["glossary", "A"] },
      { op: "remove", path: ["glossary", "C"] },
    ]);
    expect(next).toEqual({ glossary: { A: UNSET } });
  });

  it("an explicit null is written as a value", () => {
    const { edits } = save({}, { ...SHIPPED, nullable: null });
    expect(edits).toEqual([{ op: "set", path: ["nullable"], value: null }]);
  });

  it("keeps a hand-written key equal to the shipped value through an unrelated save", () => {
    const current = overlay("backup:\n  keep_daily: 7 # pinned on purpose\n");
    const { edits, next } = save(current, { ...SHIPPED, timezone: "Asia/Tokyo" });
    expect(edits).toEqual([{ op: "set", path: ["timezone"], value: "Asia/Tokyo" }]);
    expect(next).toEqual({ backup: { keep_daily: 7 }, timezone: "Asia/Tokyo" });
  });

  it("a list is one value", () => {
    expect(save({}, { ...SHIPPED, list: [2, 1] }).edits).toEqual([{ op: "set", path: ["list"], value: [2, 1] }]);
    expect(save(overlay("list: [3]\n"), SHIPPED).edits).toEqual([{ op: "remove", path: ["list"] }]);
  });

  it("brings back a key the overlay unset as a mapping diffed against the shipped one", () => {
    const current = overlay("backup: !unset\n");
    const { edits, next } = save(current, { ...SHIPPED, backup: { keep_daily: 7, keep_weekly: 1 } });
    expect(edits).toEqual([
      { op: "set", path: ["backup"], value: {} },
      { op: "set", path: ["backup", "keep_weekly"], value: 1 },
    ]);
    expect(next).toEqual({ backup: { keep_weekly: 1 } });
    expect(save(current, SHIPPED).edits).toEqual([{ op: "remove", path: ["backup"] }]);
  });

  it("inside a value that replaced a shipped scalar, a dropped key is removed (there is nothing to unset)", () => {
    const current = overlay("timezone:\n  a: 1\n  b: 2\n");
    const { edits, next } = save(current, { ...SHIPPED, timezone: { a: 1 } });
    expect(edits).toEqual([{ op: "remove", path: ["timezone", "b"] }]);
    // the emptied mapping is not dropped: it replaces the shipped scalar
    expect(save(next, { ...SHIPPED, timezone: {} }).next).toEqual({ timezone: {} });
  });

  it("a whole record is written as a whole", () => {
    const replaceAt: ReplaceAt = (path) => path.join(".") === "glossary";
    const { edits } = save({}, { ...SHIPPED, glossary: { A: "a" } }, replaceAt);
    expect(edits).toEqual([{ op: "set", path: ["glossary"], value: { A: "a" } }]);
    expect(save(overlay("glossary:\n  Z: z\n"), SHIPPED, replaceAt).edits).toEqual([{ op: "remove", path: ["glossary"] }]);
  });

  it("works on a real record rule (search keyword_groups)", () => {
    const shipped = { keyword_groups: { a: ["x"], b: ["y"] }, other: 1 };
    const { edits } = save({}, { keyword_groups: { a: ["x"] }, other: 1 }, replaceRule("search"), shipped);
    expect(edits).toEqual([{ op: "set", path: ["keyword_groups"], value: { a: ["x"] } }]);
  });

  it("returns plain edits that survive structuredClone", () => {
    const { edits } = save(overlay("glossary:\n  A: !unset\n"), { ...SHIPPED, glossary: {}, backup: { keep_daily: 1, keep_weekly: 4 } });
    expect(structuredClone(edits)).toEqual(edits);
  });
});

describe("repairOverlayEdits (a broken current file is not looked at)", () => {
  it("diffs a complete value against the shipped one alone", () => {
    const value = { ...SHIPPED, glossary: { B: "b", C: "c" }, backup: { keep_daily: 7, keep_weekly: 4 } };
    const edits = repairOverlayEdits(SHIPPED, value);
    expect(applyOverlayEdits({}, edits)).toEqual({ glossary: { A: UNSET, C: "c" } });
    expect(mergeLayers(SHIPPED, applyOverlayEdits({}, edits))).toEqual(value);
  });

  it("gives no edits for the shipped value itself", () => {
    expect(repairOverlayEdits(SHIPPED, structuredClone(SHIPPED))).toEqual([]);
  });
});

describe("applyOverlayEdits", () => {
  it("does not change its input and keeps markers", () => {
    const current = overlay("glossary:\n  A: !unset\n");
    const next = applyOverlayEdits(current, [{ op: "set", path: ["x", "y"], value: 1 }]);
    expect(next).toEqual({ glossary: { A: UNSET }, x: { y: 1 } });
    expect(current).toEqual({ glossary: { A: UNSET } });
  });

  it("replaces a marker on the way to a nested key with a mapping", () => {
    expect(applyOverlayEdits({ backup: UNSET }, [{ op: "set", path: ["backup", "keep_daily"], value: 1 }])).toEqual({ backup: { keep_daily: 1 } });
  });
});
