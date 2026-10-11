import { describe, expect, it } from "vitest";

import { offsetOfLine, shiftLines } from "@/components/settings/advanced/yaml-textarea";

describe("YamlTextarea helpers", () => {
  it("finds the offset of a line", () => {
    const text = "a: 1\nb: 2\nc: 3";
    expect(offsetOfLine(text, 1)).toBe(0);
    expect(offsetOfLine(text, 2)).toBe(5);
    expect(offsetOfLine(text, 3)).toBe(10);
    expect(offsetOfLine(text, 9)).toBe(text.length);
  });

  it("indents every line a selection touches by two spaces, keeping the selection on the same text", () => {
    const text = "a:\n  b: 1\n  c: 2\nd: 3";
    const start = text.indexOf("b");
    const end = text.indexOf("c") + 1;
    const next = shiftLines(text, start, end, false);
    expect(next.text).toBe("a:\n    b: 1\n    c: 2\nd: 3");
    expect(next.text.slice(next.start, next.end)).toBe("b: 1\n    c");
  });

  it("unindents by up to two spaces and never goes past the line start", () => {
    const text = "a:\n  b: 1\n c: 2";
    const next = shiftLines(text, 3, text.length, true);
    expect(next.text).toBe("a:\nb: 1\nc: 2");
    expect(shiftLines("x: 1", 0, 0, true).text).toBe("x: 1");
  });

  it("a selection that ends right after a newline does not touch the next line", () => {
    const text = "a\nb\nc";
    const next = shiftLines(text, 0, 4, false);
    expect(next.text).toBe("  a\n  b\nc");
  });
});
