// @vitest-environment node
import { describe, expect, it } from "vitest";

import { endsInQuestion, questionEndAsColon, stripTrailingDecoration, trailingDotsAsColon, trailingPauseAsColon } from "@/lib/ghost/heading-ends";

/** The suffix expressions the scans replace: on short lines they are the reference. */
const OLD = {
  decoration: /[\p{Extended_Pictographic}\p{So}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\s]+(:?)\s*$/u,
  pause: /\s*(?:…|\s[-–]|—)\s*$/u,
  dots: /\s*\.{3}\s*$/u,
  question: /\s*[?？]+\s*$/u,
};

const old = {
  decoration: (text: string) => text.replace(OLD.decoration, "$1"),
  pause: (text: string) => text.replace(OLD.pause, ":"),
  dots: (text: string) => text.replace(OLD.dots, ":"),
  endsInQuestion: (text: string) => OLD.question.test(text),
  question: (text: string) => text.replace(OLD.question, ":"),
};

const HEADINGS = [
  "",
  " ",
  "Your tasks",
  "Your tasks:",
  "Your tasks :",
  "Your tasks:  ",
  "Your impact 🌍",
  "Your impact 🌍 ",
  "Outcomes 🎯:",
  "Outcomes 🎯 :",
  "Outcomes🎯:",
  "Outcomes : 🎯",
  "Outcomes:🎯",
  "Outcomes ::",
  "Outcomes 🎯::",
  "What you'll do 👩‍💻",
  "What you'll do 👩🏽‍💻:",
  "Tasks ✔️",
  "Tasks ☑︎",
  "Tasks #️⃣",
  "Tasks 1️⃣:",
  "Tasks ™",
  "Tasks ©:",
  "Deine Aufgaben ",
  "Deine Aufgaben :",
  "Deine Aufgaben 🚀 : ",
  "Deine Aufgaben ",
  "Your role –",
  "Your role -",
  "Your role –",
  "Your role-",
  "Your role –  ",
  "Your role - ",
  "Your tasks—",
  "Your tasks —",
  "Your tasks…",
  "Your tasks …  ",
  "Your tasks… …",
  "Your tasks...",
  "Your tasks ...",
  "Your tasks....",
  "Your tasks. . .",
  "Your tasks .. .",
  "...",
  "…",
  "—",
  " -",
  "-",
  "What will I be doing?",
  "What will I be doing ?",
  "What will I be doing??",
  "What will I be doing ? ?",
  "What will I be doing？",
  "Was erwartet dich？ ",
  "Ready?!",
  "?",
  "Your tasks: 🚀?",
  "Your tasks?🚀",
  "\uD83D",
  "Tasks \uD83D",
  "Tasks \uDE80:",
];

/** Short strings over the characters the expressions care about, in a fixed pseudo-random order. */
function* fuzz(count: number): Generator<string> {
  const alphabet = ["a", " ", " ", " ", "\n", ":", "…", "-", "–", "—", ".", "?", "？", "🚀", "🎯", "™", "️", "‍", "⃣", "\uD83D", "\uDE80", "é"];
  let seed = 20261012;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 0; i < count; i++) {
    const length = next() % 9;
    let text = "";
    for (let j = 0; j < length; j++) text += alphabet[next() % alphabet.length];
    yield text;
  }
}

const SAMPLES = [...HEADINGS, ...fuzz(20000)];

describe("heading ends: the scans do what the suffix expressions did", () => {
  it("emoji and spaces after a heading, keeping a final colon", () => {
    expect(SAMPLES.filter((text) => stripTrailingDecoration(text) !== old.decoration(text))).toEqual([]);
    expect(stripTrailingDecoration("Your impact 🌍")).toBe("Your impact");
    expect(stripTrailingDecoration("Outcomes 🎯:")).toBe("Outcomes:");
  });

  it("a final pause", () => {
    expect(SAMPLES.filter((text) => trailingPauseAsColon(text) !== old.pause(text))).toEqual([]);
    expect(trailingPauseAsColon("Your role -")).toBe("Your role:");
  });

  it("a final three dots", () => {
    expect(SAMPLES.filter((text) => trailingDotsAsColon(text) !== old.dots(text))).toEqual([]);
    expect(trailingDotsAsColon("Your tasks...")).toBe("Your tasks:");
  });

  it("a final question mark", () => {
    expect(SAMPLES.filter((text) => endsInQuestion(text) !== old.endsInQuestion(text))).toEqual([]);
    expect(SAMPLES.filter((text) => questionEndAsColon(text) !== old.question(text))).toEqual([]);
    expect(questionEndAsColon("What will I be doing ??")).toBe("What will I be doing:");
  });
});
