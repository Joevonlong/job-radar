"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { PlaceholderBox } from "@/components/jobs/detail/panel";
import { INK_LINK } from "@/components/ui/ink-link";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import type { ReuseBase } from "@/lib/writer/similar";
import type { WorkbenchView } from "@/lib/writer/view";

import { AnswerPanel } from "./answer-panel";
import { MaterialsPanel } from "./materials-panel";
import { QuestionsPanel } from "./questions-panel";

const PANES = ["materials", "questions", "answer"] as const;
type Pane = (typeof PANES)[number];

/**
 * The workbench: the material of the selected question on the left, the job's questions in the middle, the answer
 * (write, versions, sentence evidence) on the right. Below `lg` the three columns become one, switched by a segmented
 * control. Off (or with an unreadable writer.yaml) it shows why and stays read-only.
 */
export function Workbench({ view, timeZone }: { view: WorkbenchView; timeZone: string }) {
  const t = useTranslations("writer");
  const [activeId, setActiveId] = useState<number | null>(view.questions[0]?.id ?? null);
  const active = view.questions.find((question) => question.id === activeId) ?? view.questions[0] ?? null;
  // the text of an earlier final answer a new question is being started from, until it is saved or dropped
  const [base, setBase] = useState<ReuseBase | null>(null);
  const [pane, setPane] = useState<Pane>(view.questions.length === 0 ? "questions" : "answer");
  const enabled = view.availability === "enabled";

  const select = (id: number): void => {
    setActiveId(id);
    setPane("answer");
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="writer-workbench" data-availability={view.availability}>
      {view.availability === "disabled" ? (
        <PlaceholderBox testId="writer-disabled">
          <p className="max-w-[72ch]">{t("disabled")}</p>
          <p className="mt-1.5">
            <Link href="/settings?tab=workflow" className={INK_LINK} data-testid="writer-settings-link">
              {t("settingsLink")}
            </Link>
          </p>
        </PlaceholderBox>
      ) : null}
      {view.availability === "config_error" ? <PlaceholderBox testId="writer-config-error">{t("configError")}</PlaceholderBox> : null}

      <Segmented aria-label={t("panes.label")} value={pane} onValueChange={(value) => setPane(value as Pane)} className="lg:hidden" data-testid="writer-panes">
        {PANES.map((name) => (
          <SegmentedItem key={name} value={name} data-testid={`writer-pane-${name}`}>
            {t(`panes.${name}`)}
          </SegmentedItem>
        ))}
      </Segmented>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,19rem)_minmax(0,21rem)_minmax(0,1fr)]">
        <div className={cn("min-w-0", pane !== "materials" && "max-lg:hidden")} data-testid="writer-column-materials">
          <MaterialsPanel key={active?.id ?? "none"} view={view} question={active} enabled={enabled} timeZone={timeZone} />
        </div>
        <div className={cn("min-w-0", pane !== "questions" && "max-lg:hidden")} data-testid="writer-column-questions">
          <QuestionsPanel view={view} activeId={active?.id ?? null} onSelect={select} onReuse={setBase} enabled={enabled} />
        </div>
        <div className={cn("min-w-0", pane !== "answer" && "max-lg:hidden")} data-testid="writer-column-answer">
          <AnswerPanel key={active?.id ?? "none"} view={view} question={active} base={base !== null && base.questionId === active?.id ? base : null} onBaseDone={() => setBase(null)} enabled={enabled} timeZone={timeZone} />
        </div>
      </div>
    </div>
  );
}
