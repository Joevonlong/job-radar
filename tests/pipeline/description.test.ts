// @vitest-environment node
import { describe, expect, it } from "vitest";

import { normalizeDraft } from "@/lib/pipeline";
import { cleanDescription, restoreStructure, stripTrailingUi } from "@/lib/pipeline/description";

import { draft, shippedPipeline } from "./helpers";

const config = shippedPipeline();

/** The words of a text without its whitespace: restoring structure must never change any. */
const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

describe("trailing interface text", () => {
  it.each([
    ["Build things for us. Show more Show less", "Build things for us."],
    ["Build things for us. Show less", "Build things for us."],
    ["Wir suchen dich. Mehr anzeigen Weniger anzeigen", "Wir suchen dich."],
    ["Build things.\n\nShow more\nShow less\n", "Build things."],
  ])("%s", (text, expected) => {
    expect(stripTrailingUi(text, config)).toBe(expected);
  });

  it("only cuts at the very end", () => {
    const text = "Click Show more to read on. Then apply.";
    expect(stripTrailingUi(text, config)).toBe(text);
  });
});

describe("restoring the structure of a one-paragraph description", () => {
  const sentence = (n: number) => `Sentence number ${n} says something about the job and the team.`;
  const long = Array.from({ length: 30 }, (_, i) => sentence(i + 1)).join(" ");

  it("leaves short texts and texts that already have line breaks alone", () => {
    expect(restoreStructure("A short text. With two sentences.", config)).toBe("A short text. With two sentences.");
    const structured = `${long}\n${long}`;
    expect(restoreStructure(structured, config)).toBe(structured);
  });

  it("splits a long text into paragraphs at sentence ends, without changing a word", () => {
    const out = restoreStructure(long, config);
    const paragraphs = out.split("\n\n");
    expect(paragraphs.length).toBeGreaterThan(3);
    for (const p of paragraphs.slice(0, -1)) {
      expect(p.length).toBeGreaterThanOrEqual(config.description.restore.paragraph_chars);
      expect(p).toMatch(/[.!?]$/);
    }
    expect(words(out)).toEqual(words(long));
  });

  it("puts a known section heading on its own line", () => {
    const text = `${long} What You'll Bring Five years of Python. Nice to have: Rust. Wir bieten: 30 Tage Urlaub. ${long}`;
    const out = restoreStructure(text, config);
    expect(out).toContain("\n\nWhat You'll Bring\nFive years of Python.");
    expect(out).toContain("\n\nWir bieten:\n30 Tage Urlaub.");
    expect(words(out)).toEqual(words(text));
  });

  it("does not take a heading word in the middle of a sentence for a heading", () => {
    const text = `${long} We meet all requirements of the law. The Requirements for this role are listed below.`;
    const out = restoreStructure(text, config);
    expect(out).toContain("We meet all requirements of the law.");
    expect(words(out)).toEqual(words(text));
  });

  it("does not split after an abbreviation or an initial", () => {
    const text = `${long} Kenntnisse z.B. in Rust sowie ca. 5 Jahre Erfahrung. Gehalt brutto p.a. Die Höhe hängt ab. Ask J. Smith about it.`;
    const out = restoreStructure(text, config);
    expect(out).toContain("z.B. in Rust");
    expect(out).toContain("ca. 5 Jahre");
    expect(out).toContain("p.a. Die Höhe");
    expect(out).toContain("J. Smith");
  });

  it("turns inline bullet glyphs back into list lines", () => {
    const text = `${long} → Build scalable data pipelines → Develop perception and planning → Own models from data to edge deployment`;
    const out = restoreStructure(text, config);
    expect(out).toContain("\n- Build scalable data pipelines");
    expect(out).toContain("\n- Develop perception and planning");
    expect(out).toContain("\n- Own models from data to edge deployment");
  });
});

describe("normalizeDraft and the description", () => {
  it("cuts the Show more / Show less leftover of a LinkedIn description and restores its paragraphs", () => {
    const text = `${Array.from({ length: 12 }, (_, i) => `This is sentence ${i + 1} of the job description for the role.`).join(" ")} Show more Show less`;
    const job = normalizeDraft(draft({ description: text }), config);
    expect(job.description).not.toMatch(/Show (?:more|less)/);
    expect(job.description).toContain("\n\n");
    expect(words(job.description)).toEqual(words(text.replace(/ Show more Show less$/, "")));
  });

  it("leaves a description with line breaks as it is, apart from the trailing interface text", () => {
    expect(cleanDescription("First paragraph.\n\nSecond one. Show more Show less", config)).toBe("First paragraph.\n\nSecond one.");
  });
});
