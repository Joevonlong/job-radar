"use client";

import { ClipboardCheck, Loader2, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { adoptSuggestionAction, coachAnswerAction, coachRewriteAction, type WriteActionResult, type WriterActionError } from "@/app/jobs/[id]/apply/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/actions/client";
import { toastTone } from "@/lib/toast";
import type { CoachStatus, SentenceStatus, WriteInputField } from "@/lib/writer/types";
import type { WorkbenchQuestion, WorkbenchVersion, WorkbenchView } from "@/lib/writer/view";

const DIMENSION_BADGE: Record<CoachStatus, "status-good" | "status-warn" | "destructive"> = { good: "status-good", improve: "status-warn", missing: "destructive" };
/** The dimension ids that have a label; one added in writer.yaml shows its id. */
const KNOWN_DIMENSIONS = ["answers_question", "concrete_evidence", "company_specific", "covers_must_haves", "length", "language_tone", "no_overclaim"] as const;
const SUGGESTION_BADGE: Partial<Record<SentenceStatus, "status-good" | "status-warn" | "destructive" | "status">> = {
  supported: "status-good",
  partial: "status-warn",
  ai_suggestion_unverified: "status-warn",
  framing: "status",
};

/**
 * The coach's review of one version: a score (the AI's judgement), a verdict per dimension and suggestions for single
 * sentences, each with the same evidence check as any sentence. A suggestion is adopted one at a time (a new version) or all
 * together as a rewrite (a request to the AI). The review is stored on the version it reviewed.
 */
export function CoachReview({
  view,
  question,
  version,
  enabled,
  busy,
  sends,
  run,
  onAdopted,
}: {
  view: WorkbenchView;
  question: WorkbenchQuestion;
  version: WorkbenchVersion;
  enabled: boolean;
  busy: boolean;
  sends: WriteInputField[];
  run: (call: () => Promise<WriteActionResult>) => void;
  onAdopted: (versionId: number | undefined) => void;
}) {
  const t = useTranslations("writer.coach");
  const ta = useTranslations("writer.answer");
  const ts = useTranslations("writer.status");
  const tw = useTranslations("writer");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adopting, setAdopting] = useState<number | null>(null);
  const { coach } = version;
  const ids = { jobId: view.job.id, questionId: question.id, versionId: version.id };

  const adopt = (suggestionIndex: number): void => {
    setAdopting(suggestionIndex);
    startTransition(async () => {
      const result = await callAction(() => adoptSuggestionAction({ ...ids, suggestionIndex }), () => ({ ok: false as const, error: "failed" as const }));
      setAdopting(null);
      if (!result.ok) {
        toastTone("error", tw(`actionError.${(result.error satisfies WriterActionError)}`));
        return;
      }
      toastTone("success", t("adopted"));
      router.refresh();
      onAdopted(result.versionId);
    });
  };

  return (
    <section className="border-grid flex min-w-0 flex-col gap-2.5 border-t-[1.5px] pt-3" aria-label={t("title")} data-testid="writer-coach" data-reviewed={coach !== null}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-body font-semibold">{t("title")}</h3>
        <Button type="button" size="sm" variant="outline" onClick={() => run(() => callAction(() => coachAnswerAction(ids), () => ({ ok: false as const, error: "failed" as const })))} disabled={!enabled || busy} data-testid="writer-coach-button">
          {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <ClipboardCheck aria-hidden />}
          {coach ? t("again") : t("run")}
        </Button>
      </div>
      {coach === null ? (
        <>
          <p className="text-ink-2 text-body-sm">{t("hint")}</p>
          <p className="text-ink-3 text-body-sm" data-testid="writer-coach-sends">
            <span className="font-semibold">{ta("sends")}</span> {sends.map((field) => ta(`field.${field}`)).join(" · ")}
          </p>
        </>
      ) : (
        <div className="flex min-w-0 flex-col gap-3" data-testid="writer-coach-result">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-num-m" data-testid="writer-coach-score" data-score={coach.score}>
              {t("score", { score: coach.score })}
            </span>
            <Badge variant="gate-note">{t("aiJudgement")}</Badge>
          </div>

          {coach.dimensions.length > 0 ? (
            <ul className="flex flex-col gap-1.5" aria-label={t("dimensionsLabel")} data-testid="writer-coach-dimensions">
              {coach.dimensions.map((dimension) => (
                <li key={dimension.id} className="text-body-sm flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5" data-dimension={dimension.id} data-status={dimension.status}>
                  <Badge variant={DIMENSION_BADGE[dimension.status]}>{t(`status.${dimension.status}`)}</Badge>
                  <span className="font-semibold">{KNOWN_DIMENSIONS.find((known) => known === dimension.id) ? t(`dimension.${dimension.id as (typeof KNOWN_DIMENSIONS)[number]}`) : dimension.id}</span>
                  {dimension.note ? <span className="text-ink-2 [overflow-wrap:anywhere]">{dimension.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {coach.suggestions.length > 0 ? (
            <ul className="flex flex-col gap-2" aria-label={t("suggestionsLabel")} data-testid="writer-coach-suggestions">
              {coach.suggestions.map((suggestion, index) => {
                const original = version.sentences[suggestion.sentenceIndex];
                return (
                  <li key={index} className="bg-soft rounded-card flex min-w-0 flex-col gap-1.5 px-3 py-2.5 [overflow-wrap:anywhere]" data-testid="writer-coach-suggestion" data-status={suggestion.sentence.status}>
                    {original ? (
                      <p className="text-ink-3 text-body-sm">
                        {t("sentenceN", { number: suggestion.sentenceIndex + 1 })} <q className="italic">{original.text}</q>
                      </p>
                    ) : null}
                    <p className="text-body-sm">{suggestion.issue}</p>
                    <p className="text-body">
                      <q>{suggestion.sentence.text}</q>
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={SUGGESTION_BADGE[suggestion.sentence.status] ?? "destructive"} data-testid="writer-coach-suggestion-status">
                        {ts(`label.${suggestion.sentence.status}`)}
                      </Badge>
                      <Button type="button" size="sm" variant="outline" onClick={() => adopt(index)} disabled={!enabled || busy || pending} aria-busy={adopting === index} data-testid="writer-coach-adopt">
                        {t("adopt")}
                      </Button>
                    </div>
                    {suggestion.sentence.status === "ai_suggestion_unverified" ? <p className="text-warning-text text-body-sm">{t("unverifiedNote")}</p> : null}
                    {suggestion.sentence.missing.length > 0 ? <p className="text-warning-text text-body-sm">{ts("missing", { items: suggestion.sentence.missing.join(", ") })}</p> : null}
                    {suggestion.sentence.needsCheck.length > 0 ? <p className="text-warning-text text-body-sm">{ts("needsCheck", { items: suggestion.sentence.needsCheck.join(", ") })}</p> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-ink-2 text-body-sm" data-testid="writer-coach-no-suggestions">
              {t("noSuggestions")}
            </p>
          )}

          {coach.dropped.dimensions > 0 || coach.dropped.suggestions > 0 ? (
            <p className="text-ink-3 text-body-sm" data-testid="writer-coach-dropped">
              {coach.dropped.dimensions > 0 ? t("droppedDimensions", { count: coach.dropped.dimensions }) : null}
              {coach.dropped.dimensions > 0 && coach.dropped.suggestions > 0 ? " " : null}
              {coach.dropped.suggestions > 0 ? t("droppedSuggestions", { count: coach.dropped.suggestions }) : null}
            </p>
          ) : null}

          {coach.suggestions.length > 0 ? (
            <div className="flex flex-col items-start gap-1">
              <Button type="button" size="sm" variant="primary" onClick={() => run(() => callAction(() => coachRewriteAction(ids), () => ({ ok: false as const, error: "failed" as const })))} disabled={!enabled || busy || pending} data-testid="writer-coach-rewrite">
                <Wand2 aria-hidden /> {t("rewrite")}
              </Button>
              <p className="text-ink-3 text-body-sm">{t("rewriteHint")}</p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
