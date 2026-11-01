"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { toastTone } from "@/lib/toast";
import { answeredQuestions, buildAnswersMarkdown, exportFileName } from "@/lib/writer/export";
import type { WorkbenchView } from "@/lib/writer/view";

/** Hand a text to the browser as a file download. Nothing goes through the server. */
function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // the click has started the download by now; the browser keeps the data it needs
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * "Export as Markdown": the questions that have a final answer, as one file built in the browser from what the page
 * already holds. It sends nothing anywhere, so it works with the writer switched off too.
 */
export function ExportAnswers({ view }: { view: WorkbenchView }) {
  const t = useTranslations("writer.export");
  const questions = view.questions.map((question) => ({ text: question.text, kind: question.kind, finalText: question.versions.find((version) => version.id === question.finalVersionId)?.text ?? null }));
  const ready = answeredQuestions(questions).length;

  const run = (): void => {
    try {
      const markdown = buildAnswersMarkdown(questions, { heading: t("heading"), job: t("job", { title: view.job.title, company: view.job.company }), question: t("question"), letter: t("letter"), answer: t("answer") });
      if (markdown === "") return;
      download(exportFileName({ company: view.job.company, title: view.job.title }), markdown);
      toastTone("success", t("done", { count: ready }));
    } catch {
      toastTone("error", t("failed"));
    }
  };

  return (
    <div className="border-grid flex flex-col gap-2 border-t-[1.5px] pt-3" data-testid="writer-export">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={run} disabled={ready === 0} data-testid="writer-export-button">
          <Download aria-hidden /> {t("button")}
        </Button>
        <span className="text-ink-3 text-body-sm" data-testid="writer-export-count">
          {t("count", { final: ready, total: view.questions.length })}
        </span>
      </div>
      <p className="text-ink-3 text-body-sm">{ready === 0 ? t("none") : t("hint")}</p>
    </div>
  );
}
