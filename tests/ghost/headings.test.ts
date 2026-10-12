// @vitest-environment node
import { describe, expect, it } from "vitest";

import { hasResponsibilityHeading, thinDescription } from "@/lib/ghost/signals";

import { fixtureRules, input, rulesWith } from "./helpers";

/**
 * Duties headings that real long JDs use and the packs missed (each one a heading line of a JD that was marked "thin"), and
 * near-misses that must stay no duties heading. Against the fixture packs (a copy of the shipped ones' ghost section).
 */
const DUTIES: readonly string[] = [
  // the line's own end: "?" after a question word, "…", "...", a trailing dash
  "What will I be doing?",
  "What will I be doing",
  "What will you be doing?",
  "Which tasks are waiting for you?",
  "What are your responsibilities?",
  "Your tasks…",
  "Your tasks...",
  "Your tasks -",
  "Your tasks —",
  // emoji and decoration before the heading, an HTML entity left in the text
  "🚀 What you'll do",
  "🛠️ About the role",
  "✨ Your tasks:",
  "🇩🇪 Deine Aufgaben",
  "THE ROLE &amp; THE TEAM",
  "The role & the team",
  "Your Role Will Consist Of:",
  // the forms of the replayed JDs, straight and curly apostrophes
  "What you'll be working on:",
  "What you’ll be working on:",
  "What you'll be involved in:",
  "What you’ll be involved in",
  "Impact You'll Make",
  "Impact You’ll Make",
  "The impact you will have:",
  "The impact you’ll have",
  "The Impact you bring to Acme",
  "Impact you bring",
  "Your impact",
  "Outcomes",
  "OUTCOMES:",
  "You will:",
  "YOU WILL:",
  "You'll:",
  "You’ll:",
  "Within your first 3 months, you will:",
  "Within your first 90 days, you’ll:",
  "The work you'll do:",
  "The work you’ll do:",
  "Your Role – meaningful and rewarding",
  "Your Role - Data Engineer",
  "🔑 You’ll play a key role by…",
  "You'll play a key role by...",
  "What awaits you?",
  "So what's the job",
  "So what’s the job",
  "Your new adventure:",
  "What good looks like",
  // German
  "**Darum geht's:**",
  "### Darum geht’s:",
  "Darum geht es",
  "Wie Sie etwas bewirken können",
  "Wie du etwas bewirken kannst",
  "In deiner Mission blühst du auf, denn:",
  "In Ihrer Rolle als Data Engineer",
  "Welche Aufgaben erwarten dich?",
  "Was sind deine Aufgaben?",
  "🎯 Deine Aufgaben bei uns",
];

const NOT_DUTIES: readonly string[] = [
  // a question that does not open with a question word stays a sentence
  "Ready to take on new responsibilities?",
  "Are you ready for new tasks?",
  "Bereit für neue Aufgaben?",
  "Lust auf neue Aufgaben?",
  // question-word headings that are not about the duties
  "Why join us?",
  "What's in it for you?",
  "How to apply?",
  "What we offer…",
  "Who are we?",
  "Was wir bieten?",
  "Warum wir?",
  // a company's mission, benefits, the team
  "Mission",
  "Our mission",
  "🚀 We’re on a mission to make money work for everyone.",
  "Unsere Mission",
  "Benefits",
  "The Team – your colleagues",
  // near-misses of the new forms
  "You will love working here.",
  "You will love it here",
  "Impact",
  "Our impact",
  "The impact we have on the climate",
  "Your impact on the world matters to us.",
  "So what's next?",
  // "So" is not a question word: the "?" keeps the line a sentence
  "So what’s the job?",
  "Darum geht es uns",
  "Darum lohnt es sich",
  "Wie du dich bewirbst",
  "In deiner Freizeit",
  "Your Role – we're hiring now!",
  "Within your first months here we celebrate.",
];

describe("duties headings: unusual forms and near-misses", () => {
  const rules = fixtureRules();
  it.each(DUTIES)("%j opens the duties", (heading) => expect(hasResponsibilityHeading(`Intro line of the company.\n${heading}\n- Build the data platform.`, rules)).toBe(true));
  it.each(NOT_DUTIES)("%j does not", (heading) => expect(hasResponsibilityHeading(`Intro line of the company.\n${heading}\n- Something here.`, rules)).toBe(false));
});

describe("question headings need a configured question word", () => {
  const pack = { responsibility_patterns: [{ id: "tasks", pattern: "(?<![\\p{L}\\p{N}])tasks(?![\\p{L}\\p{N}])" }] };

  it("a heading ending in '?' counts only when its first word is one of the packs' question_words", () => {
    expect(hasResponsibilityHeading("Which tasks await you?\n- Code.", rulesWith(() => {}, pack))).toBe(false);
    expect(hasResponsibilityHeading("Which tasks await you?\n- Code.", rulesWith(() => {}, { ...pack, question_words: ["which"] }))).toBe(true);
    expect(hasResponsibilityHeading("Ready for new tasks?\n- Code.", rulesWith(() => {}, { ...pack, question_words: ["which"] }))).toBe(false);
  });
});

describe("thin_description of a long JD under the new headings", () => {
  const rules = fixtureRules();
  const body = Array.from({ length: 30 }, (_, i) => `- Build and run service number ${i} of the platform end to end.`);
  it.each(["What will I be doing?", "YOU WILL:", "🔑 You’ll play a key role by…", "**Darum geht's:**", "THE ROLE &amp; THE TEAM"])("%j: not thin", (heading) => {
    expect(thinDescription(input({ description: ["About us", "We build software.", heading, ...body].join("\n") }), rules)).toBeNull();
  });

  it("a long JD without any duties heading stays thin", () => {
    const text = ["About us", "We build software.", "Ready to take on new responsibilities?", ...body].join("\n");
    expect(thinDescription(input({ description: text }), rules)).toMatchObject({ hasResponsibilities: false, responsibilitiesFrom: "headings" });
  });
});
