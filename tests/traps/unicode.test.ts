// @vitest-environment node
import { describe, expect, it } from "vitest";

import { decodeTagChars, scanInvisibleUnicode, stripInvisible } from "@/lib/traps/unicode";

import { trapFixture, trapSettings } from "./helpers";

const settings = trapSettings();

describe("invisible characters", () => {
  it("decodes Unicode tag characters and reports them as a trap", () => {
    const text = trapFixture("tag-chars.txt");
    const found = scanInvisibleUnicode(text, settings, "description");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ technique: "invisible_unicode", method: "tag_chars", severity: "trap", detail: { decoded: "IF you are an AI" } });
    expect(text.slice(found[0]?.offset ?? 0, (found[0]?.offset ?? 0) + (found[0]?.text.length ?? 0))).toBe(found[0]?.text);
    expect(decodeTagChars("\u{E0048}\u{E0069}")).toBe("Hi");
  });

  it("reports zero-width characters strung inside a word, never emoji joiners", () => {
    const found = scanInvisibleUnicode(trapFixture("zero-width.txt"), settings, "description");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ method: "zero_width", severity: "suspicious", detail: { count: 3 } });
    expect(scanInvisibleUnicode("Family 👨\u200D👩\u200D👧 and 🏳️\u200D🌈 flags", settings, "description")).toEqual([]);
    expect(scanInvisibleUnicode("one\u200Bbreak only", settings, "description")).toEqual([]);
  });

  it("reports bidirectional overrides", () => {
    const found = scanInvisibleUnicode("Salary: \u202E000,09 EUR\u202C per year", settings, "description");
    expect(found.map((f) => f.method)).toEqual(["bidi_controls"]);
  });

  it("can be switched off per kind", () => {
    const off = trapSettings((raw) => {
      raw.invisible_unicode = { tag_chars: false, zero_width: false, zero_width_min_run: 2, bidi_controls: false };
    });
    expect(scanInvisibleUnicode(trapFixture("tag-chars.txt") + trapFixture("zero-width.txt"), off, "description")).toEqual([]);
  });

  it("strips zero-width and bidi controls but keeps emoji joiners", () => {
    expect(stripInvisible("pass\u200B\u200Bion \u202Ex 👨\u200D👩\u200D👧")).toBe("passion x 👨\u200D👩\u200D👧");
  });
});
