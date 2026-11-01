/**
 * The Markdown file of a job's final answers: the question and the answer you marked as final, one block per question.
 * Pure text building (client-safe): the page turns the result into a download in the browser, so nothing is written on
 * the server and nothing leaves the machine. Questions without a final answer are left out.
 */

export interface ExportQuestion {
  text: string;
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
  /** Label before each answer, e.g. "Answer". */
  answer: string;
}

/** A text of yours must not turn into Markdown structure: a line that starts like a heading, list, quote, rule or fence gets its first mark escaped. */
function escapeLines(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/^(\s*)(?:([#>*+\-=]|`{3,}|~{3,})|(\d+)([.)]))/u, (_, space: string, mark: string | undefined, digits: string | undefined, stop: string | undefined) => (mark === undefined ? `${space}${digits}\\${stop}` : `${space}\\${mark}`)))
    .join("\n")
    .trim();
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
    lines.push(`## ${index + 1}`, "", `**${labels.question}**`, "");
    for (const line of escapeLines(question.text).split("\n")) lines.push(line === "" ? ">" : `> ${line}`);
    lines.push("", `**${labels.answer}**`, "", escapeLines(question.finalText), "");
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
