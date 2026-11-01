import { describe, expect, it } from "vitest";

import { answeredQuestions, buildAnswersMarkdown, exportFileName } from "@/lib/writer/export";

const labels = { heading: "Application answers", job: "Backend Engineer · Acme", question: "Question", answer: "Answer" };

describe("buildAnswersMarkdown", () => {
  it("writes the question and the final answer of each answered question, in order, and leaves the others out", () => {
    const markdown = buildAnswersMarkdown(
      [
        { text: "Why do you want to join us?", finalText: "I like the product.\n\nI led a migration." },
        { text: "Not answered yet", finalText: null },
        { text: "Blank final", finalText: "   " },
        { text: "Describe a challenge", finalText: "Errors fell by 40%." },
      ],
      labels,
    );
    expect(markdown).toBe(
      [
        "# Application answers",
        "",
        "Backend Engineer · Acme",
        "",
        "## 1",
        "",
        "**Question**",
        "",
        "> Why do you want to join us?",
        "",
        "**Answer**",
        "",
        "I like the product.",
        "",
        "I led a migration.",
        "",
        "## 2",
        "",
        "**Question**",
        "",
        "> Describe a challenge",
        "",
        "**Answer**",
        "",
        "Errors fell by 40%.",
        "",
      ].join("\n"),
    );
    expect(markdown).not.toContain("Not answered yet");
  });

  it("is empty when no question has a final answer", () => {
    expect(buildAnswersMarkdown([], labels)).toBe("");
    expect(buildAnswersMarkdown([{ text: "Q", finalText: null }], labels)).toBe("");
  });

  it("keeps a multi-line question inside the quote and does not let your text become headings, lists or fences", () => {
    const markdown = buildAnswersMarkdown([{ text: "Tell us:\n\n# about you\n- and why", finalText: "# Heading\n> quote\n- item\n1. first\n2) second\n```\ncode\n```\n---\nplain # not at start" }], labels);
    expect(markdown).toContain("> Tell us:\n>\n> \\# about you\n> \\- and why");
    expect(markdown).toContain("\\# Heading\n\\> quote\n\\- item\n1\\. first\n2\\) second\n\\```\ncode\n\\```\n\\---\nplain # not at start");
    expect(markdown.split("\n").filter((line) => line.startsWith("#"))).toEqual(["# Application answers", "## 1"]);
  });

  it("normalises line endings", () => {
    expect(buildAnswersMarkdown([{ text: "Q", finalText: "a\r\nb" }], labels)).toContain("a\nb");
  });
});

describe("answeredQuestions", () => {
  it("keeps the extra fields of the questions it returns", () => {
    expect(answeredQuestions([{ id: 1, text: "Q", finalText: "A" }, { id: 2, text: "R", finalText: null }])).toEqual([{ id: 1, text: "Q", finalText: "A" }]);
  });
});

describe("exportFileName", () => {
  it("is the company and the title as a plain file name", () => {
    expect(exportFileName({ company: "Acme GmbH", title: "Senior Backend Engineer (m/w/d)" })).toBe("acme-gmbh-senior-backend-engineer-m-w-d-answers.md");
  });

  it("folds accents, keeps other scripts, and cuts a long name", () => {
    expect(exportFileName({ company: "Müller & Söhne", title: "Entwickler" })).toBe("muller-sohne-entwickler-answers.md");
    expect(exportFileName({ company: "北京公司", title: "工程师" })).toBe("北京公司-工程师-answers.md");
    const long = exportFileName({ company: "a".repeat(100), title: "b" });
    expect(long.length).toBeLessThanOrEqual(60 + "-answers.md".length);
    expect(long.endsWith("-answers.md")).toBe(true);
  });

  it("never carries a path or a bare extension", () => {
    expect(exportFileName({ company: "../../etc", title: "/passwd" })).toBe("etc-passwd-answers.md");
    expect(exportFileName({ company: "", title: "" })).toBe("application-answers.md");
  });
});
