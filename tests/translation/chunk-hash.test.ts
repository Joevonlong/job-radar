// @vitest-environment node
import { describe, expect, it } from "vitest";

import { joinChunks, splitIntoChunks } from "@/lib/translation/chunk";
import { descriptionHash, isTranslationStale } from "@/lib/translation/hash";

describe("descriptionHash / staleness", () => {
  it("is the SHA-256 of the UTF-8 text, stable, and treats a missing description as empty", () => {
    expect(descriptionHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(descriptionHash("Größe — 价格")).toBe(descriptionHash("Größe — 价格"));
    expect(descriptionHash(null)).toBe(descriptionHash(""));
    expect(descriptionHash("a")).not.toBe(descriptionHash("b"));
  });

  it("marks a translation outdated once the description hashes differently", () => {
    const hash = descriptionHash("We offer 80k.");
    expect(isTranslationStale(hash, "We offer 80k.")).toBe(false);
    expect(isTranslationStale(hash, "We offer 90k.")).toBe(true);
    expect(isTranslationStale(hash, "We offer 80k. ")).toBe(true); // any change counts
    expect(isTranslationStale(hash, null)).toBe(true);
  });
});

describe("splitIntoChunks", () => {
  it("keeps a short text in one piece and returns nothing for blank text", () => {
    expect(splitIntoChunks("Hello\n\nWorld", 100)).toEqual(["Hello\n\nWorld"]);
    expect(splitIntoChunks("  \n\n ", 100)).toEqual([]);
  });

  it("packs whole paragraphs into pieces of at most maxChars", () => {
    const paragraphs = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40)];
    const chunks = splitIntoChunks(paragraphs.join("\n\n"), 90);
    expect(chunks).toEqual([`${paragraphs[0]}\n\n${paragraphs[1]}`, `${paragraphs[2]}\n\n${paragraphs[3]}`]);
    expect(joinChunks(chunks)).toBe(paragraphs.join("\n\n"));
  });

  it("cuts a paragraph longer than the limit at line breaks, then at spaces, then anywhere", () => {
    const lines = Array.from({ length: 6 }, (_, i) => `- item ${i} ${"x".repeat(20)}`).join("\n");
    const byLine = splitIntoChunks(lines, 70);
    expect(byLine.length).toBeGreaterThan(1);
    expect(byLine.every((c) => c.length <= 70)).toBe(true);
    expect(byLine.join("\n").replace(/\n+/g, "\n")).toBe(lines);

    const words = Array.from({ length: 30 }, () => "word").join(" ");
    const bySpace = splitIntoChunks(words, 40);
    expect(bySpace.every((c) => c.length <= 40)).toBe(true);
    expect(bySpace.join(" ")).toBe(words);

    const blob = "z".repeat(250);
    expect(splitIntoChunks(blob, 100).map((c) => c.length)).toEqual([100, 100, 50]);
  });
});
