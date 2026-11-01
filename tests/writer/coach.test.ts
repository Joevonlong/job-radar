import { describe, expect, it } from "vitest";

import { coachOutputSchema } from "@/lib/ai/prompts/write";
import { applySuggestion, parseStoredCoach } from "@/lib/writer/coach";
import type { CheckedSentence } from "@/lib/writer/types";

const sentence = (text: string, over: Partial<CheckedSentence> = {}): CheckedSentence => ({ text, newParagraph: false, about: "user", status: "user_written", evidence: [], missing: [], needsCheck: [], ...over });

const stored = (over: Record<string, unknown> = {}) => ({
  score: 64,
  dimensions: [{ id: "answers_question", status: "improve", note: "Half of it." }],
  suggestions: [{ sentenceIndex: 1, issue: "Name the project.", sentence: sentence("Errors fell by 40% after the move.", { status: "supported", evidence: [{ source: "draft", quote: "Errors fell by 40%", problem: null }] }) }],
  dropped: { dimensions: 1, suggestions: 0 },
  provider: "codex-cli",
  model: "m",
  promptVersion: "write-coach-v1",
  createdAt: "2026-11-01T10:00:00.000Z",
  ...over,
});

describe("the coach's output", () => {
  const output = (over: Record<string, unknown> = {}) => ({ score: 80, dimensions: [{ id: "length", status: "good", note: "ok" }], suggestions: [], ...over });

  it("takes a score from 0 to 100 and rejects one outside", () => {
    expect(coachOutputSchema.safeParse(output({ score: 0 })).success).toBe(true);
    expect(coachOutputSchema.safeParse(output({ score: 100 })).success).toBe(true);
    expect(coachOutputSchema.safeParse(output({ score: 101 })).success).toBe(false);
    expect(coachOutputSchema.safeParse(output({ score: -1 })).success).toBe(false);
    expect(coachOutputSchema.safeParse(output({ score: "high" })).success).toBe(false);
  });

  it("leaves an unknown dimension id to the handler (it is dropped and counted there), but rejects an unknown verdict", () => {
    expect(coachOutputSchema.safeParse(output({ dimensions: [{ id: "vibes", status: "good", note: "" }] })).success).toBe(true);
    expect(coachOutputSchema.safeParse(output({ dimensions: [{ id: "length", status: "great", note: "" }] })).success).toBe(false);
  });

  it("a suggestion names a sentence, what is wrong, a rewrite, what it is about and its evidence", () => {
    const ok = { sentence_index: 0, issue: "Vague.", rewrite: "Better.", about: "user", evidence: [{ source: "draft", quote: "text" }] };
    expect(coachOutputSchema.safeParse(output({ suggestions: [ok] })).success).toBe(true);
    expect(coachOutputSchema.safeParse(output({ suggestions: [{ ...ok, sentence_index: -1 }] })).success).toBe(false);
    expect(coachOutputSchema.safeParse(output({ suggestions: [{ ...ok, rewrite: "" }] })).success).toBe(false);
    expect(coachOutputSchema.safeParse(output({ suggestions: [{ ...ok, evidence: [{ source: "web", quote: "x" }] }] })).success).toBe(false);
  });
});

describe("parseStoredCoach", () => {
  it("reads what the handler stores", () => {
    const coach = parseStoredCoach(stored());
    expect(coach).toMatchObject({ score: 64, dropped: { dimensions: 1, suggestions: 0 }, promptVersion: "write-coach-v1" });
    expect(coach?.suggestions[0]?.sentence.evidence[0]).toEqual({ source: "draft", quote: "Errors fell by 40%", problem: null });
  });

  it("is no review when nothing is stored or the row does not parse", () => {
    expect(parseStoredCoach(null)).toBeNull();
    expect(parseStoredCoach(undefined)).toBeNull();
    expect(parseStoredCoach({ score: "x" })).toBeNull();
    expect(parseStoredCoach(stored({ score: 140 }))).toBeNull();
    expect(parseStoredCoach(stored({ dimensions: [{ id: "length", status: "great", note: "" }] }))).toBeNull();
  });

  it("an older row without the dropped counts still reads", () => {
    expect(parseStoredCoach(stored({ dropped: undefined }))?.dropped).toEqual({ dimensions: 0, suggestions: 0 });
  });
});

describe("applySuggestion", () => {
  const sentences = [sentence("I moved our billing service to Kotlin."), sentence("Errors fell by 40%.", { newParagraph: true }), sentence("That is why.", { status: "framing" })];

  it("puts the suggested sentence, with its own check result, in place of the one it is about", () => {
    const suggestion = parseStoredCoach(stored())!.suggestions[0]!;
    const applied = applySuggestion(sentences, suggestion)!;
    expect(applied.map((entry) => entry.text)).toEqual(["I moved our billing service to Kotlin.", "Errors fell by 40% after the move.", "That is why."]);
    expect(applied[1]).toMatchObject({ status: "supported", newParagraph: true });
    // the other sentences are untouched
    expect(applied[0]).toBe(sentences[0]);
    expect(applied[2]).toBe(sentences[2]);
  });

  it("is null for a sentence the version does not have", () => {
    const suggestion = parseStoredCoach(stored({ suggestions: [{ sentenceIndex: 7, issue: "x", sentence: sentence("y") }] }))!.suggestions[0]!;
    expect(applySuggestion(sentences, suggestion)).toBeNull();
  });
});
