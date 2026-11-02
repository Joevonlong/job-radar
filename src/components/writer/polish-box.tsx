"use client";

import { Wand2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { polishAnswerAction, type WriteActionResult } from "@/app/jobs/[id]/apply/actions";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/actions/client";
import { textLength } from "@/lib/writer/diff";
import { POLISH_OPTIONS, type PolishOption, type WriteInputField } from "@/lib/writer/types";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

/**
 * "Improve my draft": your own text in any language, fitted to the job or with only its language and wording changed. The
 * result is a new version whose sentences are checked like a draft's (your text is the evidence of what it says). Nothing is
 * stored until the request is done; the text lives in the request only while it runs.
 */
export function PolishBox({
  view,
  question,
  enabled,
  busy,
  sends,
  run,
}: {
  view: WorkbenchView;
  question: WorkbenchQuestion;
  enabled: boolean;
  busy: boolean;
  /** What a polish with this option sends (the same list the request builds its input from). */
  sends: (option: PolishOption) => WriteInputField[];
  run: (call: () => Promise<WriteActionResult>) => void;
}) {
  const t = useTranslations("writer.polish");
  const ta = useTranslations("writer.answer");
  const tw = useTranslations("writer");
  const [text, setText] = useState("");
  const [option, setOption] = useState<PolishOption>("align_to_job");
  const id = useId();
  const tooLong = text.length > view.limits.draftMaxChars;

  return (
    <details className="border-grid bg-card rounded-card border-bw border-border group px-3 py-2.5" data-testid="writer-polish">
      <summary className="focus-visible:ring-ring cursor-pointer rounded-[3px] text-body font-semibold focus-visible:ring-2 focus-visible:outline-none">
        <Wand2 className="mr-1.5 inline size-4 align-text-bottom" aria-hidden />
        {t("title")}
      </summary>
      <div className="mt-2.5 flex min-w-0 flex-col gap-2.5">
        <p className="text-ink-2 text-body-sm">{t("hint")}</p>
        <label htmlFor={id} className="text-body-sm font-semibold">
          {t("textLabel")}
        </label>
        <Textarea id={id} value={text} onChange={(event) => setText(event.target.value)} rows={8} placeholder={t("placeholder")} disabled={!enabled || busy} data-testid="writer-polish-text" />
        <p className={tooLong ? "text-bad text-data font-mono" : "text-ink-3 text-data font-mono"} data-testid="writer-polish-length">
          {tooLong ? t("tooLong", { max: view.limits.draftMaxChars }) : ta("length", { count: textLength(text, question.lengthUnit), target: question.lengthValue, unit: tw(`questions.unit.${question.lengthUnit}`) })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label={t("optionLabel")} value={option} onChange={(event) => setOption(event.target.value as PolishOption)} disabled={!enabled || busy} size="sm" data-testid="writer-polish-option">
            {POLISH_OPTIONS.map((name) => (
              <option key={name} value={name}>
                {t(`option.${name}`)}
              </option>
            ))}
          </NativeSelect>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => run(() => callAction(() => polishAnswerAction({ jobId: view.job.id, questionId: question.id, text, option }), () => ({ ok: false as const, error: "failed" as const })))}
            disabled={!enabled || busy || text.trim() === "" || tooLong}
            data-testid="writer-polish-button"
          >
            {t("run")}
          </Button>
        </div>
        <p className="text-ink-3 text-body-sm" data-testid="writer-polish-explain">
          {t(`explain.${option}`)}
        </p>
        <p className="text-body-sm" data-testid="writer-polish-sends">
          <span className="font-semibold">{ta("sends")}</span> {sends(option).map((field) => ta(`field.${field}`)).join(" · ")}
        </p>
      </div>
    </details>
  );
}
