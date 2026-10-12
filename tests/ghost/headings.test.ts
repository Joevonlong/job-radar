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
  // arrows and guillemets before it, emoji after it
  "→ Your tasks",
  "» Deine Aufgaben",
  "Your impact 🌍",
  "Outcomes 🎯:",
  "➡️ What you’ll do",
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
  "Our impact 🌍",
  "→ Our mission",
];

/**
 * A line ending in "?" or "..." / "…" reads as a heading only when a list follows it: on its own (prose after it) it is a sentence
 * of the company text, even after a question word.
 */
const SENTENCES_WITHOUT_LIST: readonly string[] = [
  "Which tasks can our AI automate?",
  "How does Acme reduce your daily tasks?",
  "We automate repetitive tasks...",
  "Learn more about our day-to-day...",
  "What do our customers' teams do day-to-day?",
  "What will I be doing?",
  "Welche Aufgaben übernimmt unsere KI?",
];

describe("duties headings: unusual forms and near-misses", () => {
  const rules = fixtureRules();
  it.each(DUTIES)("%j opens the duties", (heading) => expect(hasResponsibilityHeading(`Intro line of the company.\n${heading}\n- Build the data platform.`, rules)).toBe(true));
  it.each(NOT_DUTIES)("%j does not", (heading) => expect(hasResponsibilityHeading(`Intro line of the company.\n${heading}\n- Something here.`, rules)).toBe(false));
});

describe("a heading ending in '?' or '...' needs a list right after it", () => {
  const rules = fixtureRules();
  it.each(SENTENCES_WITHOUT_LIST)("%j followed by prose: no duties heading", (line) => {
    expect(hasResponsibilityHeading(`Intro line of the company.\n${line}\nWe help teams ship faster with less toil.`, rules)).toBe(false);
    expect(hasResponsibilityHeading(`Intro line of the company.\n${line}`, rules)).toBe(false);
  });
  it.each(["What will I be doing?", "Welche Aufgaben erwarten dich?", "Your tasks...", "Your tasks…"])("%j followed by a list (after a blank line too): duties heading", (line) => {
    expect(hasResponsibilityHeading(`Intro.\n${line}\n- Build the platform.`, rules)).toBe(true);
    expect(hasResponsibilityHeading(`Intro.\n${line}\n\n1. Build the platform.`, rules)).toBe(true);
  });
});

/** A line ending in the ellipsis character is a heading as it always was, a list after it or not ("Your tasks…" / prose). */
const ELLIPSIS_HEADINGS: readonly string[] = ["Your tasks…", "Your responsibilities…", "Deine Aufgaben…", "In this role…", "🔑 You’ll play a key role by…"];

describe("a line ending in '…' is a heading without a list too", () => {
  const rules = fixtureRules();
  it.each(ELLIPSIS_HEADINGS)("%j followed by prose: duties heading", (line) => {
    expect(hasResponsibilityHeading(`Intro line of the company.\n${line}\nYou build and run the data platform with the team.`, rules)).toBe(true);
  });
  it("a long JD under 'Your responsibilities…' with prose duties is not thin", () => {
    const prose = Array.from({ length: 30 }, (_, i) => `You build and run service number ${i} of the platform end to end.`);
    expect(thinDescription(input({ description: ["About us", "We build software.", "Your responsibilities…", ...prose].join("\n") }), rules)).toBeNull();
  });
});

describe("one lead-in line between the heading and its list", () => {
  const rules = fixtureRules();
  // the lead-in ends in ":" or is itself heading-shaped (short, no end punctuation)
  it.each([
    ["What will I be doing?", "As a Senior AI Infrastructure Engineer focused on model training and inference, you will:"],
    ["What will I be doing?", "You will:"],
    ["What will I be doing?", "Product Engineers in the AI Group"],
    ["Welche Aufgaben erwarten dich?", "Als Data Engineer wirst du:"],
    ["Your tasks...", "In the platform team"],
  ])("%j, lead-in %j, then the list: duties heading", (line, lead) => {
    expect(hasResponsibilityHeading(`Intro.\n${line}\n\n${lead}\n\n- Build the platform.`, rules)).toBe(true);
  });
  // a sentence between them: the "?" or "..." line was a question or remark of the company text
  it.each([
    ["Which tasks can our AI automate?", "Almost all of them."],
    ["What will I be doing?", "As a senior engineer you join the platform team."],
    ["Welche Aufgaben übernimmt unsere KI?", "Fast alle davon."],
    ["We automate repetitive tasks...", "Our customers love it!"],
  ])("%j, sentence %j, then a list: no duties heading", (line, lead) => {
    expect(hasResponsibilityHeading(`Intro.\n${line}\n${lead}\n- Invoice matching.\n- Ticket routing.`, rules)).toBe(false);
  });
  it("a long JD whose only candidate is a question, a sentence, then a feature list stays thin", () => {
    const features = Array.from({ length: 30 }, (_, i) => `- Invoice matching for ledger number ${i} of the customer, end to end.`);
    const text = ["About us", "Which tasks can our AI automate?", "Almost all of them.", ...features].join("\n");
    expect(thinDescription(input({ description: text }), rules)).toMatchObject({ hasResponsibilities: false, responsibilitiesFrom: "headings" });
  });
  it.each(["Which tasks can our AI automate?", "Welche Aufgaben übernimmt unsere KI?", "We automate repetitive tasks..."])("%j, two lines of prose, then a list: no duties heading", (line) => {
    expect(hasResponsibilityHeading(`Intro.\n${line}\nWe help teams ship faster.\nOur customers love it.\n- Feature one.`, rules)).toBe(false);
  });
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

  it("a long JD whose only candidate is a question in the prose stays thin", () => {
    const text = ["About us", "Which tasks can our AI automate?", "We help teams ship faster.", ...body.map((line) => line.slice(2))].join("\n");
    expect(thinDescription(input({ description: text }), rules)).toMatchObject({ hasResponsibilities: false, responsibilitiesFrom: "headings" });
  });

  it("a long JD without any duties heading stays thin", () => {
    const text = ["About us", "We build software.", "Ready to take on new responsibilities?", ...body].join("\n");
    expect(thinDescription(input({ description: text }), rules)).toMatchObject({ hasResponsibilities: false, responsibilitiesFrom: "headings" });
  });
});
