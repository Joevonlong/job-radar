"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";

import { saveBaseVersionAction } from "@/app/jobs/[id]/apply/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/actions/client";
import { toastTone } from "@/lib/toast";
import { textLength } from "@/lib/writer/diff";
import type { ReuseBase } from "@/lib/writer/similar";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

import { OldCompanyNotice } from "./old-company-notice";

/**
 * The editor a new question starts in when you chose to start from an earlier final answer: the answer's text is filled in,
 * and nothing is stored until you save it as the question's first version. Changing the company, the figures and the
 * details that belong to the other job is up to you; the notice points at the other company's name while it is still there.
 */
export function BaseEditor({ view, question, base, enabled, onDone }: { view: WorkbenchView; question: WorkbenchQuestion; base: ReuseBase; enabled: boolean; onDone: () => void }) {
  const t = useTranslations("writer.reuse");
  const tw = useTranslations("writer");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [text, setText] = useState(base.text);
  const id = useId();

  const save = (): void => {
    startTransition(async () => {
      const result = await callAction(() => saveBaseVersionAction({ jobId: view.job.id, questionId: question.id, sourceVersionId: base.sourceVersionId, text }), () => ({ ok: false as const, error: "failed" as const }));
      if (!result.ok) {
        toastTone("error", tw(`actionError.${result.error}`));
        return;
      }
      toastTone("success", t("saved"));
      onDone();
      router.refresh();
    });
  };

  return (
    <div className="border-grid bg-card rounded-card border-bw border-border flex min-w-0 flex-col gap-2.5 px-3 py-3" data-testid="writer-base-editor">
      <h3 className="text-body font-semibold">{t("editorTitle")}</h3>
      <p className="text-ink-2 text-body-sm [overflow-wrap:anywhere]">{t("editorHint", { company: base.company, title: base.jobTitle })}</p>
      <label htmlFor={id} className="sr-only">
        {t("editorLabel")}
      </label>
      <Textarea id={id} value={text} onChange={(event) => setText(event.target.value)} rows={10} disabled={!enabled} data-testid="writer-base-text" />
      <p className="text-ink-3 text-data font-mono">{tw("answer.length", { count: textLength(text, question.lengthUnit), target: question.lengthValue, unit: tw(`questions.unit.${question.lengthUnit}`) })}</p>
      <OldCompanyNotice text={text} from={[{ company: base.company, names: base.companyNames }]} currentNames={view.job.companyNames} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="primary" onClick={save} disabled={!enabled || pending || text.trim() === ""} data-testid="writer-base-save">
          {t("save")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone} disabled={pending} data-testid="writer-base-discard">
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}
