"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { SingleSelect } from "@/components/ui/single-select";
import { confirmReplyAction as rawConfirm, dismissReplyAction as rawDismiss, reassignReplyAction as rawReassign, recategorizeReplyAction as rawRecategorize, undoReplyAction as rawUndo, type ReplyActionResult } from "@/app/pipeline/actions";
import { withActionFeedback } from "@/lib/actions/client";
import { PICKABLE_CATEGORIES } from "@/lib/replies/types";
import { toastTone } from "@/lib/toast";

import type { ReplyLinkView, ReplyView } from "./to-reply-views";

const FAILED: ReplyActionResult = { ok: false, error: "failed" };
const confirmReply = withActionFeedback(rawConfirm)(() => FAILED);
const undoReply = withActionFeedback(rawUndo)(() => FAILED);
const dismissReply = withActionFeedback(rawDismiss)(() => FAILED);
const reassignReply = withActionFeedback(rawReassign)(() => FAILED);
const recategorizeReply = withActionFeedback(rawRecategorize)(() => FAILED);

/** One reply: what it is, which application it seems to belong to, and what it suggests. Subject and quote render as text, never as markup. */
export function ReplyRow({ reply, links, confirmed = false }: { reply: ReplyView; links: readonly ReplyLinkView[]; confirmed?: boolean }) {
  const t = useTranslations("replies");
  const tStatus = useTranslations("dashboard.status");
  const [pending, start] = useTransition();

  const run = (action: () => Promise<ReplyActionResult>, done: "confirmed" | "undone" | "dismissed" | "linked" | "categorized") =>
    start(async () => {
      const result = await action();
      if (!result.ok) return void toastTone("error", t("toast.failed"));
      if (result.outcome === "done") return void toastTone("success", t(`toast.${done}`));
      toastTone("warn", t(`toast.${result.outcome}`));
    });

  const { suggestion } = reply;
  const suggestionText = (() => {
    switch (suggestion.kind) {
      case "status":
        return t("suggestion.status", { from: tStatus(suggestion.from), to: tStatus(suggestion.to) });
      case "next_action":
        return suggestion.due
          ? t("suggestion.send_materials", { action: t(`nextAction.${suggestion.action}`), due: suggestion.due })
          : t("suggestion.interview", { action: t(`nextAction.${suggestion.action}`) });
      case "mismatch":
        return t("suggestion.mismatch", { from: tStatus(suggestion.from) });
      case "none":
        return t("suggestion.none");
    }
  })();
  const canConfirm = reply.match === "matched" && (suggestion.kind === "status" || suggestion.kind === "next_action");
  const candidates = new Set(reply.candidateJobIds);
  const linkOptions = [...links.filter((link) => candidates.has(link.jobId)), ...links.filter((link) => !candidates.has(link.jobId))].map((link) => ({
    value: String(link.jobId),
    label: t("panel.candidate", { company: link.company, title: link.title }),
  }));
  const categoryOptions = [...(reply.category === "unclassified" ? [{ value: "", label: t("category.unclassified") }] : []), ...PICKABLE_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) }))];
  const linkChoices = [...(reply.jobId === null ? [{ value: "", label: t("panel.noApplication") }] : []), ...linkOptions];

  return (
    <li className="border-grid gap-sp-1 p-sp-2 rounded-cell flex flex-col border" data-testid="reply-row" data-reply-id={reply.id} data-category={reply.category} data-match={reply.match}>
      <div className="gap-x-sp-2 gap-y-1 flex flex-wrap items-center">
        <span className="bg-soft text-ink border-ink text-data-sm rounded-cell inline-flex h-5 items-center border px-1.5 font-mono leading-none font-bold whitespace-nowrap" data-testid="reply-category">
          {t(`category.${reply.category}`)}
        </span>
        <span className="text-body-sm min-w-0 font-bold [overflow-wrap:anywhere]" data-testid="reply-application">
          {reply.company ? t("panel.candidate", { company: reply.company, title: reply.title ?? "" }) : reply.match === "ambiguous" ? t("panel.ambiguous") : t("panel.unmatched")}
        </span>
      </div>
      <p className="text-body-sm [overflow-wrap:anywhere]" data-testid="reply-subject">{reply.subject ?? t("panel.noSubject")}</p>
      {reply.quote ? <blockquote className="text-ink-2 border-grid text-body-sm border-l-2 pl-2 [overflow-wrap:anywhere]" data-testid="reply-quote">{reply.quote}</blockquote> : null}
      <p className="text-ink-3 text-data-sm font-mono [overflow-wrap:anywhere]">
        {t("panel.from", { domain: reply.senderDomain })} · {t("panel.received", { date: reply.receivedLabel })}
      </p>
      {reply.suspiciousInstruction ? (
        <p className="text-warning-text text-body-sm gap-1 flex items-start" role="note" data-testid="reply-suspicious">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("panel.suspicious")}
        </p>
      ) : null}
      {confirmed ? null : <p className="text-body-sm font-medium" data-testid="reply-suggestion">{suggestionText}</p>}
      <div className="gap-sp-2 mt-1 flex flex-wrap items-end">
        {confirmed ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => undoReply({ id: reply.id }), "undone")} data-testid="reply-undo">
            {t("panel.undo")}
          </Button>
        ) : (
          <>
            {canConfirm ? (
              <Button type="button" size="sm" disabled={pending} onClick={() => run(() => confirmReply({ id: reply.id }), "confirmed")} data-testid="reply-confirm">
                {t("panel.confirm")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => dismissReply({ id: reply.id }), "dismissed")} data-testid="reply-dismiss">
              {t("panel.dismiss")}
            </Button>
            <SingleSelect
              layout="popover"
              label={t("panel.category")}
              options={categoryOptions}
              value={reply.category === "unclassified" ? "" : reply.category}
              onChange={(category) => {
                if (category !== "" && category !== reply.category) run(() => recategorizeReply({ id: reply.id, category }), "categorized");
              }}
              testId="reply-category-select"
              className="w-44"
            />
          </>
        )}
        <SingleSelect
          layout="popover"
          label={t("panel.link")}
          options={linkChoices}
          value={reply.jobId === null ? "" : String(reply.jobId)}
          onChange={(jobId) => {
            if (jobId !== "" && Number(jobId) !== reply.jobId) run(() => reassignReply({ id: reply.id, jobId: Number(jobId) }), "linked");
          }}
          testId="reply-link-select"
          className="min-w-0 sm:w-72"
        />
      </div>
    </li>
  );
}
