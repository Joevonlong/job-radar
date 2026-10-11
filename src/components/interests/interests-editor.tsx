"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toastTone } from "@/lib/toast";

import { previewCategoryAction, saveVocabularyAction } from "@/app/interests/actions";
import { IDLE_INTERESTS_STATE, type InterestsActionState } from "@/lib/interests/types";
import type { InterestsPageData } from "@/lib/interests/view";
import type { VocabularyDraft } from "@/lib/interests/vocabulary-draft";

import { ViewsPanel } from "./views-panel";
import { VocabularyForm } from "./vocabulary-form";
import { WatchedPanel } from "./watched-panel";

function LoadError({ message }: { message: string }) {
  const t = useTranslations("interests.loadError");
  return (
    <div role="alert" className="border-bad bg-card flex flex-col gap-1 rounded-card border-bw px-4 py-3 text-body">
      <p className="text-bad flex items-center gap-2 font-bold">
        <AlertTriangle aria-hidden className="size-4" />
        {t("title")}
      </p>
      <p className="text-ink-2">{t("hint")}</p>
      <pre className="text-ink-2 mt-1 font-mono text-data break-words whitespace-pre-wrap">{message}</pre>
    </div>
  );
}

function RecomputeNotice({ state }: { state: InterestsActionState }) {
  const t = useTranslations("interests.recompute");
  const tp = useTranslations("interests.preview");
  if (state.status !== "saved" || state.section !== "vocabulary" || !state.recompute) return null;
  const { recompute } = state;
  return (
    <div role="status" data-testid="recompute-result" className="border-border bg-card flex flex-col gap-1 rounded-card border-bw px-4 py-2.5 text-body shadow-e1">
      <p className="font-medium">{recompute.reconciled ? t("done", { checked: recompute.checked, updated: recompute.updated }) : t("failed")}</p>
      {recompute.rescanPending ? <p className="text-ink-2">{t("rescan")}</p> : null}
      {recompute.reviewPending ? <p className="text-ink-2">{t("review")}</p> : null}
      {recompute.reviewEstimate ? (
        <p className="text-ink-2" data-testid="recompute-review-estimate">
          {tp("reviewEstimate", { jobs: recompute.reviewEstimate.jobs, rounds: recompute.reviewEstimate.rounds === null || recompute.reviewEstimate.jobs === 0 ? "none" : String(recompute.reviewEstimate.rounds) })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The /interests page body. The vocabulary save lives here (not in the form) so its result survives
 * the remount that follows every save: the form is keyed by the hash of the saved vocabulary.
 */
export function InterestsEditor({ data }: { data: InterestsPageData }) {
  const t = useTranslations("interests");
  const [state, setState] = useState<InterestsActionState>(IDLE_INTERESTS_STATE);
  const [pending, startTransition] = useTransition();

  function save(draft: VocabularyDraft) {
    startTransition(async () => {
      const result = await saveVocabularyAction(draft);
      setState(result);
      if (result.status === "saved") toastTone("success", t("vocabulary.savedToast"), { id: `vocabulary-${result.nonce}` });
    });
  }

  if (data.loadError !== null || data.vocabulary === null) return <LoadError message={data.loadError ?? ""} />;

  return (
    <div className="flex flex-col gap-4">
      <RecomputeNotice state={state} />
      <VocabularyForm
        key={data.vocabulary.hash}
        initial={data.vocabulary.draft}
        signalCounts={data.signalCounts}
        state={state}
        pending={pending}
        onSave={save}
        presets={data.presets}
        aiReviewWithoutCandidates={data.aiReviewWithoutCandidates}
        onPreview={(draft, categoryId) => previewCategoryAction({ draft, categoryId })}
      />
      <ViewsPanel views={data.views} trends={data.trends} />
      <WatchedPanel watched={data.watched} />
    </div>
  );
}
