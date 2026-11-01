/**
 * The Markdown file of a job's final answers: the question and the answer you marked as final, one block per question.
 * Pure text building (client-safe): the page turns the result into a download in the browser, so nothing is written on
 * the server and nothing leaves the machine. Questions without a final answer are left out.
 */

export interface ExportQuestion {
  text: string;
  /** A cover letter has no question text of its own to show. */
  kind: "question" | "letter";
  /** The text of the final version; null when the question has none yet. */
  finalText: string | null;
}

/** The words of the file that are not yours (the page passes the translations; this module has no UI text). */
export interface ExportLabels {
  /** Title of the file, e.g. "Application answers". */
  heading: string;
  /** Line under the title naming the job, e.g. "Backend Engineer · Acme". */
  job: string;
  /** Label before each question, e.g. "Question". */
  question: string;
  /** What stands in the quote of a cover letter whose question text is empty, e.g. "Cover letter". */
  letter: string;
  /** Label before each answer, e.g. "Answer". */
  answer: string;
}

/**
 * A text of yours must not change the structure of the file. Per line: a first mark that would make a heading, list item,
 * quote, rule, setext underline or code fence is escaped; indentation of 4 columns or more (an indented code block) is
 * written as no-break spaces; and every `<` is escaped so no raw HTML gets through.
 */
function escapeLines(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      const indented = line.replace(/^[ \t]+/u, (space) => (space.replace(/\t/gu, "    ").length >= 4 ? "\u00a0".repeat(space.replace(/\t/gu, "    ").length) : space));
      return indented
        .replace(/^(\s*)(?:([#>*+\-=_]|`{3,}|~{3,})|(\d+)([.)]))/u, (_, space: string, mark: string | undefined, digits: string | undefined, stop: string | undefined) => (mark === undefined ? `${space}${digits}\\${stop}` : `${space}\\${mark}`))
        .replace(/</gu, "\\<");
    })
    .join("\n")
    // leading blank lines and trailing space go; a first line's own indentation stays
    .replace(/^(?:[ \t]*\n)+/u, "")
    .trimEnd();
}

/** The questions that have a final answer, in order. */
export function answeredQuestions<T extends ExportQuestion>(questions: readonly T[]): (T & { finalText: string })[] {
  return questions.filter((question): question is T & { finalText: string } => question.finalText !== null && question.finalText.trim() !== "");
}

/** The Markdown of the final answers of one job; an empty string when no question has a final answer. */
export function buildAnswersMarkdown(questions: readonly ExportQuestion[], labels: ExportLabels): string {
  const answered = answeredQuestions(questions);
  if (answered.length === 0) return "";
  const lines = [`# ${labels.heading.replace(/\s+/gu, " ").trim()}`, "", escapeLines(labels.job), ""];
  answered.forEach((question, index) => {
    lines.push(`## ${index + 1}`, "");
    const asked = question.text.trim() === "" && question.kind === "letter" ? labels.letter : question.text;
    // a question without any text (and not a letter) has no quote to show
    if (asked.trim() !== "") {
      lines.push(`**${labels.question}**`, "");
      for (const line of escapeLines(asked).split("\n")) lines.push(line === "" ? ">" : `> ${line}`);
      lines.push("");
    }
    lines.push(`**${labels.answer}**`, "", escapeLines(question.finalText), "");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/** A file name for the download: the letters and digits of the company and title joined by `-`, ending in `-answers.md`. */
export function exportFileName(parts: { company: string; title: string }): string {
  const slug = `${parts.company} ${parts.title}`
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "");
  return `${slug === "" ? "application" : slug}-answers.md`;
}
