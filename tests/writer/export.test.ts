import { describe, expect, it } from "vitest";

import { answeredQuestions, buildAnswersMarkdown, exportFileName } from "@/lib/writer/export";

const labels = { heading: "Application answers", job: "Backend Engineer · Acme", question: "Question", letter: "Cover letter", answer: "Answer" };
const q = (text: string, finalText: string | null, kind: "question" | "letter" = "question") => ({ text, kind, finalText });

describe("buildAnswersMarkdown", () => {
  it("writes the question and the final answer of each answered question, in order, and leaves the others out", () => {
    const markdown = buildAnswersMarkdown(
      [
        q("Why do you want to join us?", "I like the product.\n\nI led a migration."),
        q("Not answered yet", null),
        q("Blank final", "   "),
        q("Describe a challenge", "Errors fell by 40%."),
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
    expect(buildAnswersMarkdown([q("Q", null)], labels)).toBe("");
  });

  it("keeps a multi-line question inside the quote and does not let your text become headings, lists or fences", () => {
    const markdown = buildAnswersMarkdown([q("Tell us:\n\n# about you\n- and why", "# Heading\n> quote\n- item\n1. first\n2) second\n```\ncode\n```\n---\nplain # not at start")], labels);
    expect(markdown).toContain("> Tell us:\n>\n> \\# about you\n> \\- and why");
    expect(markdown).toContain("\\# Heading\n\\> quote\n\\- item\n1\\. first\n2\\) second\n\\```\ncode\n\\```\n\\---\nplain # not at start");
    expect(markdown.split("\n").filter((line) => line.startsWith("#"))).toEqual(["# Application answers", "## 1"]);
  });

  it("keeps underscores rules, deep indentation and raw HTML from changing the structure", () => {
    const markdown = buildAnswersMarkdown([q("Q", "Intro\n___\n    indented like code\n\tTab indented\n<script>alert(1)</script> and <b>bold</b>\n  two spaces are fine")], labels);
    const answer = markdown.split("**Answer**\n\n")[1]!.trimEnd().split("\n");
    expect(answer).toEqual(["Intro", "\\___", "\u00a0\u00a0\u00a0\u00a0indented like code", "\u00a0\u00a0\u00a0\u00a0Tab indented", "\\<script>alert(1)\\</script> and \\<b>bold\\</b>", "  two spaces are fine"]);
    // no line of the answer is indented like code, and none can open a tag
    expect(answer.some((line) => /^( {4,}|\t)/u.test(line))).toBe(false);
    expect(answer.some((line) => /(^|[^\\])</u.test(line))).toBe(false);
  });

  it("keeps the first line's indentation when it is deep", () => {
    expect(buildAnswersMarkdown([q("Q", "      deep start")], labels)).toContain("**Answer**\n\n\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0deep start\n");
  });

  it("escapes the job line and the quote the same way", () => {
    const markdown = buildAnswersMarkdown([q("<i>Why</i>\n# us", "A")], { ...labels, job: "# Engineer · <Acme>" });
    expect(markdown).toContain("\n\\# Engineer · \\<Acme>\n");
    expect(markdown).toContain("> \\<i>Why\\</i>\n> \\# us\n");
  });

  it("a cover letter without question text is quoted by its label; any other question without text has no quote", () => {
    const markdown = buildAnswersMarkdown([q("  ", "Dear team", "letter"), q("", "Plain answer")], labels);
    expect(markdown).toContain("## 1\n\n**Question**\n\n> Cover letter\n\n**Answer**\n\nDear team\n");
    expect(markdown).toContain("## 2\n\n**Answer**\n\nPlain answer\n");
    expect(markdown).not.toMatch(/^>\s*$/mu);
    expect(markdown.match(/\*\*Question\*\*/gu)).toHaveLength(1);
  });

  it("normalises line endings", () => {
    expect(buildAnswersMarkdown([q("Q", "a\r\nb")], labels)).toContain("a\nb");
  });
});

describe("answeredQuestions", () => {
  it("keeps the extra fields of the questions it returns", () => {
    expect(answeredQuestions([{ id: 1, ...q("Q", "A") }, { id: 2, ...q("R", null) }])).toEqual([{ id: 1, ...q("Q", "A") }]);
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
