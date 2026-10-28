"use client";

import { Languages, Loader2, RefreshCw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";

import { translateJobAction as rawTranslateJobAction, translateStatusAction as rawTranslateStatusAction, type PartialPayload, type TranslateErrorKey, type TranslateStatusResult, type TranslationPayload } from "@/app/jobs/[id]/actions";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest, type ControlRequestRead } from "@/components/control/use-control-request";
import { Button } from "@/components/ui/button";
import { controlQueueViewSchema, type ControlQueueView } from "@/lib/control/request-view-schema";
import { formatClock } from "@/lib/format/clock";
import { parseTranslation, type MarkerCategories, type TranslationSegment } from "@/lib/translation/render";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { markClass } from "./marks";
import { PlaceholderBox } from "./panel";
import { callAction, withActionFeedback } from "@/lib/actions/client";

const translateJobAction = withActionFeedback(rawTranslateJobAction)(() => ({ ok: false, error: "failed" }));
const translateStatusAction = (input: Parameters<typeof rawTranslateStatusAction>[0]) => callAction(() => rawTranslateStatusAction(input), () => null);

const NO_CATEGORIES: MarkerCategories = [];

export interface TranslationView {
  content: string;
  provider: string | null;
  /** ISO timestamp. */
  createdAt: string;
  /** Made from an older version of the JD. */
  stale: boolean;
}

interface TranslationPanelProps {
  jobId: number;
  /** The job has JD text at all (nothing to translate otherwise). */
  hasDescription: boolean;
  initial: TranslationView | null;
  /** The pieces of an earlier, unfinished translation (a failed attempt keeps them); only shown while there is no complete translation. */
  initialPartial?: PartialView | null;
  /** An unfinished `translate_job` request of this job: the tab waits for it and polls, also after a reload. */
  initialRequest?: WaitingRequest | null;
  /** Time zone for the "translated at" time (schedule.yaml). */
  timeZone: string;
  /** The active signal categories: which highlights are shown, in which colour. */
  categories?: MarkerCategories;
  /** The language translations are made in (`language.yaml: translation.target`): its name in the interface language and its `lang` tag. */
  target: { name: string; lang: string };
}

/** A translation that is not finished: the text of the pieces that are done and how far it got. */
export interface PartialView extends PartialPayload {
  /** Why the last attempt stopped (a code of `translation.error`), when it did. */
  errorCode?: string | null;
  errorDetail?: string | null;
}

/** A translation left for the ai-worker: the tab asks for its state until it is done. `queue`: where it stood when the page was rendered. */
interface WaitingRequest {
  requestId: number;
  stage: "pending" | "running";
  queue?: ControlQueueView | null;
}

type StatusFailure = Extract<TranslateStatusResult, { ok: false }>;
type TranslateRead = ControlRequestRead<{ partial: PartialPayload | null }, TranslationPayload, StatusFailure>;

/** The status action's answer in the shape `useControlRequest` reads. */
async function readTranslation(jobId: number, requestId: number): Promise<TranslateRead> {
  const result = await translateStatusAction({ jobId, requestId });
  if (result === null) return null;
  if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: result };
  if (result.state === "waiting") {
    const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
    return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: { partial: result.partial } } : null;
  }
  return { state: "done", done: result.translation };
}

/**
 * The translation tab: the cached translation (into the configured target language), or a button that asks for it. The AI runs on the host,
 * so the button queues a request and the tab polls it until the translation is there.
 */
export function TranslationPanel({ jobId, hasDescription, initial, initialPartial = null, initialRequest = null, timeZone, categories = NO_CATEGORIES, target }: TranslationPanelProps) {
  const t = useTranslations("translation");
  const format = useFormatter();
  const [translation, setTranslation] = useState<TranslationView | null>(initial);
  const [error, setError] = useState<{ key: TranslateErrorKey; detail: string | null; resumeAt?: string | null } | null>(
    initialPartial?.errorCode ? { key: initialPartial.errorCode as TranslateErrorKey, detail: initialPartial.errorDetail ?? null } : null,
  );
  // the time Job Radar's AI usage cap is expected to let the AI work again (a `quota_guard` failure); "none" = not known
  const resumeTime = (resumeAt: string | null | undefined): string => (resumeAt ? formatClock(format, resumeAt, timeZone) : "none");
  const [partial, setPartial] = useState<PartialPayload | null>(initialPartial);
  const [pending, startTransition] = useTransition();
  const [waiting, setWaiting] = useState<WaitingRequest | null>(initialRequest);
  const requestId = waiting?.requestId ?? null;

  // Follow the server after a refresh (the cycle translated this job while the page was open).
  const [seen, setSeen] = useState(initial);
  if (seen !== initial && (seen?.createdAt !== initial?.createdAt || seen?.stale !== initial?.stale)) {
    setSeen(initial);
    setTranslation(initial);
  }

  const fail = (key: TranslateErrorKey, detail: string | null = null, resumeAt: string | null = null): void => {
    setError({ key, detail, resumeAt });
    toastTone("error", t(`error.${key}`, { language: target.name, time: resumeTime(resumeAt) }));
  };

  // Follow the queued request until the ai-worker has finished it: no wait limit, the queue hint says when the worker is offline.
  const wait = useControlRequest({
    requestId,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue ?? null,
    read: (id) => readTranslation(jobId, id),
    onDone: (done) => {
      setTranslation(done);
      setPartial(null);
      setWaiting(null);
      toastTone("success", t("done"));
    },
    onFailed: (failed, last) => {
      setWaiting(null);
      const kept = failed?.partial ?? last?.partial ?? null;
      if (kept) setPartial(kept);
      fail(failed?.error ?? "not_found", failed?.detail ?? null, failed?.resumeAt ?? null);
    },
  });
  const stage = waiting ? wait.stage : null;

  const shownPartial = translation === null ? (wait.waiting?.partial ?? partial) : null;
  const blocks = useMemo(() => (translation ? parseTranslation(translation.content, categories) : []), [translation, categories]);
  const partialBlocks = useMemo(() => (shownPartial && shownPartial.content !== "" ? parseTranslation(shownPartial.content, categories) : []), [shownPartial, categories]);
  const highlighted = blocks.some((block) => (block.type === "paragraph" ? block.segments.some((s) => s.tier) : block.type === "list" ? block.items.some((item) => item.some((s) => s.tier)) : false));

  const busy = pending || waiting !== null;

  const run = (): void => {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof translateJobAction>>;
      try {
        result = await translateJobAction({ jobId, force: translation?.stale ?? false });
      } catch {
        result = { ok: false, error: "failed" };
      }
      if (!result.ok) {
        fail(result.error);
      } else if (result.queued) {
        setWaiting({ requestId: result.requestId, stage: "pending" });
      } else {
        setTranslation(result.translation);
        toastTone("success", result.cached ? t("loadedFromCache") : t("done"));
      }
    });
  };

  const button = (label: string, variant: "default" | "outline", icon: "translate" | "refresh") => (
    <Button type="button" variant={variant} onClick={run} disabled={busy} aria-busy={busy} data-testid="translate-button">
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : icon === "refresh" ? <RefreshCw aria-hidden /> : <Languages aria-hidden />}
      {busy ? t("translating") : label}
    </Button>
  );

  if (!hasDescription && !translation) {
    return <PlaceholderBox testId="translation-empty">{t("noDescription")}</PlaceholderBox>;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="translation-panel">
      {translation?.stale ? (
        <div role="note" className="border-warning/40 bg-warning/10 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5" data-testid="translation-stale">
          <span className="min-w-0 [overflow-wrap:anywhere]">{t("stale")}</span>
          {hasDescription ? button(t("retranslate"), "outline", "refresh") : null}
        </div>
      ) : null}

      {translation ? (
        <>
          {highlighted ? <p className="text-muted-foreground text-xs">{t("legend")}</p> : null}
          <TranslationBody blocks={blocks} lang={target.lang} testId="translation-body" />
          <p className="text-muted-foreground text-xs" data-testid="translation-note">
            {t("note", {
              language: target.name,
              time: format.dateTime(new Date(translation.createdAt), { dateStyle: "medium", timeStyle: "short", timeZone }),
              provider: translation.provider ?? "—",
            })}
          </p>
        </>
      ) : shownPartial ? (
        <div className="flex flex-col gap-3" data-testid="translation-partial" data-done={shownPartial.done} data-total={shownPartial.total}>
          <div
            role="note"
            data-busy={busy}
            className={cn(
              "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5",
              // while a translation is running the partial text is progress, not a problem
              busy ? "border-border bg-muted/40" : "border-warning/40 bg-warning/10",
            )}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">{t(busy ? "partialRunning" : "partialNote", { done: shownPartial.done, total: shownPartial.total })}</span>
            {hasDescription && !waiting ? button(t("continue"), "outline", "refresh") : null}
          </div>
          {partialBlocks.length > 0 ? <TranslationBody blocks={partialBlocks} lang={target.lang} testId="translation-partial-body" /> : null}
        </div>
      ) : (
        <div className="border-border flex flex-col items-start gap-3 rounded-lg border border-dashed px-4 py-4" data-testid="translation-none">
          <p className="text-muted-foreground max-w-[60ch]">{t("none")}</p>
          {button(error ? t("retry") : t("translate", { language: target.name }), "default", error ? "refresh" : "translate")}
        </div>
      )}

      {busy ? (
        <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm" data-testid="translation-loading" data-stage={stage ?? "requesting"}>
          <Loader2 className="size-4 animate-spin" aria-hidden />{" "}
          {shownPartial && shownPartial.total > 0 && stage !== "pending"
            ? t("progress", { done: shownPartial.done, total: shownPartial.total })
            : stage === "pending"
              ? t("queued")
              : t("loading")}
        </p>
      ) : null}
      {busy ? <QueueHint queue={wait.queue} stage={stage} timeZone={timeZone} /> : null}
      {error && !busy ? (
        <div role="alert" className="text-destructive text-sm [overflow-wrap:anywhere]" data-testid="translation-error">
          <p>{t(`error.${error.key}`, { language: target.name, time: resumeTime(error.resumeAt) })}</p>
          {error.detail ? (
            <p className="text-muted-foreground mt-0.5 font-mono text-xs" data-testid="translation-error-detail">
              {error.detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TranslationBody({ blocks, lang, testId }: { blocks: ReturnType<typeof parseTranslation>; lang: string; testId: string }) {
  return (
    <div className="max-w-[72ch] [overflow-wrap:anywhere]" lang={lang} data-testid={testId}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <h3 key={index} className="mt-4 font-semibold first:mt-0">
              {block.text}
            </h3>
          );
        }
        if (block.type === "list") {
          return (
            <ul key={index} className="mt-1.5 flex flex-col gap-1">
              {block.items.map((segments, itemIndex) => (
                <li key={itemIndex} className="before:bg-muted-foreground relative pl-4 before:absolute before:top-[0.7em] before:left-[3px] before:size-1 before:rounded-full">
                  <Segments segments={segments} />
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index} className="mt-3 first:mt-0">
            <Segments segments={block.segments} />
          </p>
        );
      })}
    </div>
  );
}

function Segments({ segments }: { segments: TranslationSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        const text = segment.bold ? <strong className="font-semibold">{segment.text}</strong> : segment.text;
        if (!segment.tier || !segment.color) return <span key={index}>{text}</span>;
        return (
          <mark key={index} title={segment.tier} className={cn("rounded-cell px-0.5", markClass(segment.color))} data-tier={segment.tier}>
            {text}
          </mark>
        );
      })}
    </>
  );
}
