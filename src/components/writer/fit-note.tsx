"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { fitStatusAction, requestFitAction } from "@/app/jobs/[id]/apply/actions";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest } from "@/components/control/use-control-request";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/actions/client";
import { controlQueueViewSchema } from "@/lib/control/request-view-schema";
import { toastTone } from "@/lib/toast";
import { emphasisFromFit } from "@/lib/writer/fit";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

/**
 * "What this means for your application": where the ticked company background meets the chosen stories. Every point shows its two
 * quotes, and what the check could not find. Only the words of your own story can go on into the emphasis note, and only from a point
 * that passed: what lands there counts as your word.
 */
export function FitNote({ view, question, enabled, timeZone, onAddToEmphasis }: { view: WorkbenchView; question: WorkbenchQuestion; enabled: boolean; timeZone: string; onAddToEmphasis: (text: string) => void }) {
  const t = useTranslations("writer.materials.fit");
  const te = useTranslations("writer.answer.error");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requestId, setRequestId] = useState<number | null>(view.fit.openRequestId);
  const wait = useControlRequest({
    requestId,
    read: async (id) => {
      const result = await callAction(() => fitStatusAction({ jobId: view.job.id, requestId: id }), () => null);
      if (result === null) return null;
      if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: result.error };
      if (result.state === "done") return { state: "done", done: null };
      const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
      return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: null } : null;
    },
    onDone: () => {
      setRequestId(null);
      router.refresh();
    },
    onFailed: (error) => {
      setRequestId(null);
      toastTone("error", te(error ?? "not_found", { time: "none" }));
    },
  });
  const run = (): void => {
    startTransition(async () => {
      const result = await callAction(() => requestFitAction({ jobId: view.job.id, questionId: question.id }), () => ({ ok: false as const, error: "failed" as const }));
      if (!result.ok) toastTone("error", te(result.error, { time: "none" }));
      else setRequestId(result.requestId);
    });
  };
  const busy = pending || requestId !== null;

  return (
    <div className="mt-2 flex flex-col items-start gap-2" data-testid="writer-fit">
      <Button type="button" size="sm" variant="outline" onClick={run} disabled={!enabled || busy} aria-busy={busy} data-testid="writer-fit-button">
        {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles aria-hidden />}
        {busy ? t("requesting") : t("button")}
      </Button>
      {!enabled && !busy ? <p className="text-ink-3 text-body-sm">{t("needs")}</p> : null}
      {requestId !== null ? <QueueHint queue={wait.queue} stage={wait.stage} timeZone={timeZone} /> : null}
      {view.fit.outdated ? (
        <p className="text-warning-text text-body-sm" role="status" data-testid="writer-fit-outdated">
          {t("outdated")}
        </p>
      ) : null}
      {view.fit.createdAt !== "" && view.fit.items.length === 0 ? <p className="text-ink-3 text-body-sm" data-testid="writer-fit-empty">{t("empty")}</p> : null}
      {view.fit.items.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-3" data-testid="writer-fit-items">
          {view.fit.items.map((item) => {
            const addition = emphasisFromFit(item);
            return (
              <li key={`${item.companyPoint}|${item.yourPoint}`} className="text-body-sm flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]" data-testid="writer-fit-item" data-status={item.status}>
                <p>
                  <span className="text-ink-3">{t("companyPoint")}</span> {item.companyPoint}
                </p>
                <p className="text-ink-3 text-data">“{item.companyQuote}”</p>
                <p>
                  <span className="text-ink-3">{t("yourPoint")}</span> {item.yourPoint}
                </p>
                <p className="text-ink-3 text-data">“{item.storyQuote}”</p>
                {item.flags.length > 0 ? (
                  <p className="text-warning-text" role="status" data-testid="writer-fit-flags">
                    {item.flags.map((flag) => t(`flag.${flag}`)).join(" ")}
                    {item.missing.length > 0 ? ` ${t("missing", { names: item.missing.join(", ") })}` : ""}
                  </p>
                ) : null}
                {addition !== null ? (
                  <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => onAddToEmphasis(addition)} disabled={!enabled} data-testid="writer-fit-add">
                    {t("add")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
