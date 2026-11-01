"use client";

import { Check, Copy, Loader2, Pencil, RefreshCw, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";

import { saveManualVersionAction, setFinalVersionAction, writeAnswerAction, writerStatusAction, type WriteErrorKey, type WriterActionError } from "@/app/jobs/[id]/apply/actions";
import { QueueHint } from "@/components/control/queue-hint";
import { nodeLabels } from "@/components/settings/field-control";
import { useControlRequest } from "@/components/control/use-control-request";
import { Panel, PanelAside } from "@/components/jobs/detail/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/actions/client";
import { controlQueueViewSchema, type ControlQueueView } from "@/lib/control/request-view-schema";
import { formatClock } from "@/lib/format/clock";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { textLength } from "@/lib/writer/diff";
import { jdPointKey } from "@/lib/writer/jd-points";
import { writeInputFields } from "@/lib/writer/materials";
import type { CheckedSentence, SentenceStatus, StatusCounts } from "@/lib/writer/types";
import type { WorkbenchQuestion, WorkbenchVersion, WorkbenchView } from "@/lib/writer/view";

type Failure = { error: WriteErrorKey; detail: string | null; resumeAt: string | null };

/** How each status reads in the text: a coloured underline, never colour alone (the detail names the status). */
/** The shipped variant ids that have a label; a variant added in writer.yaml shows its id. */
const VARIANT_LABELS = ["safe", "distinctive", "short"] as const;
const variantLabel = (id: string | null): (typeof VARIANT_LABELS)[number] | null => VARIANT_LABELS.find((entry) => entry === id) ?? null;

const MARK: Record<SentenceStatus, string> = {
  supported: "decoration-good",
  partial: "decoration-warn decoration-wavy",
  unsupported: "decoration-bad decoration-wavy bg-[color-mix(in_srgb,var(--bad)_12%,transparent)]",
  framing: "decoration-transparent",
  web_unverified: "decoration-warn decoration-dotted",
  user_written: "decoration-ink-3 decoration-dotted",
  ai_suggestion_unverified: "decoration-warn decoration-dotted",
  external_unverified: "decoration-warn decoration-dotted",
};
const COUNT_BADGE: Record<keyof StatusCounts, "status-good" | "status-warn" | "destructive" | "status" | "gate-note"> = {
  supported: "status-good",
  partial: "status-warn",
  unsupported: "destructive",
  framing: "status",
  user_written: "status",
  web_unverified: "gate-note",
};
const COUNT_KEYS = Object.keys(COUNT_BADGE) as (keyof StatusCounts)[];

function Counts({ counts, testId }: { counts: StatusCounts; testId?: string }) {
  const t = useTranslations("writer.status");
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid={testId}>
      {COUNT_KEYS.filter((key) => counts[key] > 0).map((key) => (
        <Badge key={key} variant={COUNT_BADGE[key]} data-status={key} data-count={counts[key]}>
          {t(`count.${key}`, { count: counts[key] })}
        </Badge>
      ))}
    </span>
  );
}

/**
 * The answer of the selected question: what is sent and to whom, the "write" button (a `writer_job` request polled
 * until the ai-worker is done), the versions, and the selected version sentence by sentence with its evidence.
 */
export function AnswerPanel({ view, question, enabled, timeZone }: { view: WorkbenchView; question: WorkbenchQuestion | null; enabled: boolean; timeZone: string }) {
  const t = useTranslations("writer.answer");
  const tw = useTranslations("writer");
  const variantName = (id: string | null): string => {
    const known = variantLabel(id);
    return known ? tw(`variant.${known}`) : (id ?? "");
  };
  const tSettings = useTranslations("settings");
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const initial = question?.initialRequest ?? null;
  const [waiting, setWaiting] = useState<{ requestId: number; stage: "pending" | "running"; queue: ControlQueueView | null } | null>(
    initial?.state === "waiting" ? { requestId: initial.requestId, stage: initial.stage, queue: initial.queue } : null,
  );
  const [failure, setFailure] = useState<Failure | null>(initial?.state === "failed" ? { error: initial.error, detail: initial.detail, resumeAt: initial.resumeAt } : null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const resumeTime = (resumeAt: string | null): string => (resumeAt ? formatClock(format, resumeAt, timeZone) : "none");
  const fail = (next: Failure): void => {
    setFailure(next);
    toastTone("error", t(`error.${next.error}`, { time: resumeTime(next.resumeAt) }));
  };

  const wait = useControlRequest({
    requestId: waiting?.requestId ?? null,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue ?? null,
    read: async (id) => {
      const result = await callAction(() => writerStatusAction({ jobId: view.job.id, requestId: id }), () => null);
      if (result === null) return null;
      if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: { error: result.error, detail: result.detail ?? null, resumeAt: result.resumeAt ?? null } };
      if (result.state === "done") return { state: "done", done: null };
      const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
      return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: null } : null;
    },
    onDone: () => {
      setWaiting(null);
      setSelectedId(null);
      toastTone("success", t("done"));
      router.refresh();
    },
    onFailed: (failed) => {
      setWaiting(null);
      fail(failed ?? { error: "not_found", detail: null, resumeAt: null });
      // a request that expired while its handler ran may still have stored versions
      router.refresh();
    },
  });

  if (!question) {
    return (
      <Panel id="writer-answer" title={t("title")}>
        <p className="text-ink-2 text-body-sm" data-testid="writer-answer-empty">
          {t("noQuestion")}
        </p>
      </Panel>
    );
  }

  const busy = pending || waiting !== null;
  const write = (): void => {
    setFailure(null);
    startTransition(async () => {
      const result = await callAction(() => writeAnswerAction({ jobId: view.job.id, questionId: question.id }), () => ({ ok: false as const, error: "failed" as const }));
      if (!result.ok) fail({ error: result.error, detail: null, resumeAt: null });
      else setWaiting({ requestId: result.requestId, stage: "pending", queue: null });
    });
  };

  // what "write" sends, from the saved selection (the same list the request builds its input from)
  const points = new Set(view.jdPoints.map(jdPointKey));
  const stories = new Set(view.stories.map((story) => story.id));
  const fields = writeInputFields({
    jdPoints: question.selection.jdPoints.filter((ref) => points.has(jdPointKey(ref))),
    useJdText: question.selection.useJdText && view.job.hasDescription,
    profile: question.selection.profile && view.profile.available ? true : null,
    stories: question.selection.storyIds.filter((id) => stories.has(id)),
    emphasis: question.selection.emphasis.trim() === "" ? null : question.selection.emphasis,
  });
  const selected = question.versions.find((version) => version.id === selectedId) ?? question.versions.find((version) => version.id === question.finalVersionId) ?? question.versions[0] ?? null;

  return (
    <Panel id="writer-answer" title={t("title")} aside={<PanelAside>{t("variants", { count: view.kinds[question.kind].variants })}</PanelAside>}>
      <div className="flex flex-col gap-4" data-testid="writer-answer" data-state={busy ? "waiting" : failure ? "failed" : selected ? "done" : "ready"}>
        <div className="bg-soft rounded-card flex flex-col gap-1 px-3 py-2.5" data-testid="writer-disclosure">
          <p className="text-body-sm">
            <span className="font-semibold">{t("sends")}</span> {fields.map((field) => t(`field.${field}`)).join(" · ")}
          </p>
          <p className="text-body-sm" data-testid="writer-disclosure-providers">
            <span className="font-semibold">{t("sendsTo")}</span> {view.providers.length > 0 ? ((labels) => view.providers.map((id) => labels[id] ?? id).join(" → "))(nodeLabels(tSettings, view.providers)) : t("noProvider")}
          </p>
          <p className="text-ink-3 text-body-sm">{t("noWeb")}</p>
        </div>

        <div className="flex flex-col items-start gap-2">
          <Button type="button" variant="primary" onClick={write} disabled={!enabled || busy} aria-busy={busy} data-testid="writer-write-button">
            {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : question.versions.length > 0 ? <RefreshCw aria-hidden /> : <Sparkles aria-hidden />}
            {busy ? (wait.stage === "running" ? t("running") : t("requesting")) : question.versions.length > 0 ? t("writeAgain") : t("write")}
          </Button>
          {busy ? <QueueHint queue={wait.queue} stage={wait.stage} timeZone={timeZone} /> : null}
          {failure && !busy ? (
            <div role="alert" className="text-bad text-body-sm [overflow-wrap:anywhere]" data-testid="writer-error" data-error={failure.error}>
              <p className="font-semibold">{t(`error.${failure.error}`, { time: resumeTime(failure.resumeAt) })}</p>
              {failure.detail ? <p className="text-ink-3 text-data mt-0.5 font-mono">{failure.detail}</p> : null}
            </div>
          ) : null}
        </div>

        {question.versions.length > 0 ? (
          <ul className="flex flex-col gap-1.5" aria-label={t("versionsLabel")} data-testid="writer-versions">
            {question.versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(version.id)}
                  aria-current={version.id === selected?.id ? "true" : undefined}
                  className={cn(
                    "rounded-card border-bw border-border hover:bg-soft focus-visible:ring-ring flex w-full min-w-0 flex-wrap items-center gap-1.5 px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none motion-reduce:transition-none",
                    version.id === selected?.id ? "bg-soft shadow-e2" : "bg-card",
                  )}
                  data-testid="writer-version"
                  data-version-id={version.id}
                  data-mode={version.mode}
                >
                  <span className="text-body-sm font-semibold">{version.mode === "manual" ? t("manual") : variantName(version.variantId)}</span>
                  <span className="text-ink-3 text-data font-mono">{format.dateTime(new Date(version.createdAt), { dateStyle: "short", timeStyle: "short", timeZone })}</span>
                  {version.id === question.finalVersionId ? (
                    <Badge variant="status-good">
                      <Check aria-hidden /> {t("final")}
                    </Badge>
                  ) : null}
                  <Counts counts={version.counts} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {selected ? <VersionView key={selected.id} view={view} question={question} version={selected} enabled={enabled} onSaved={(id) => setSelectedId(id ?? null)} /> : null}
      </div>
    </Panel>
  );
}

function VersionView({ view, question, version, enabled, onSaved }: { view: WorkbenchView; question: WorkbenchQuestion; version: WorkbenchVersion; enabled: boolean; onSaved: (id: number | undefined) => void }) {
  const t = useTranslations("writer.answer");
  const tw = useTranslations("writer");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const editId = useId();
  const isFinal = version.id === question.finalVersionId;
  const length = textLength(version.text, question.lengthUnit);

  const paragraphs: { sentence: CheckedSentence; index: number }[][] = [];
  version.sentences.forEach((sentence, index) => {
    if (paragraphs.length === 0 || sentence.newParagraph) paragraphs.push([]);
    paragraphs[paragraphs.length - 1]!.push({ sentence, index });
  });

  const report = (result: { ok: true } | { ok: false; error: WriterActionError }, success: string): boolean => {
    if (!result.ok) {
      toastTone("error", tw(`actionError.${result.error}`));
      return false;
    }
    toastTone("success", success);
    router.refresh();
    return true;
  };
  const toggleFinal = (): void => {
    startTransition(async () => {
      report(await callAction(() => setFinalVersionAction({ jobId: view.job.id, questionId: question.id, versionId: isFinal ? null : version.id }), () => ({ ok: false as const, error: "failed" })), isFinal ? t("unfinalised") : t("finalised"));
    });
  };
  const saveEdit = (): void => {
    if (editing === null) return;
    startTransition(async () => {
      const result = await callAction(() => saveManualVersionAction({ jobId: view.job.id, questionId: question.id, parentVersionId: version.id, text: editing }), () => ({ ok: false as const, error: "failed" as const }));
      if (report(result, t("editSaved"))) {
        setEditing(null);
        onSaved(result.ok ? result.versionId : undefined);
      }
    });
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(version.text);
      toastTone("success", t("copied"));
    } catch {
      toastTone("error", t("copyFailed"));
    }
  };
  const detail = open === null ? null : version.sentences[open] ?? null;

  return (
    <div className="border-grid flex min-w-0 flex-col gap-3 border-t-[1.5px] pt-3" data-testid="writer-version-view" data-version-id={version.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Counts counts={version.counts} testId="writer-version-counts" />
        <span className="text-ink-3 text-data font-mono" data-testid="writer-version-length">
          {t("length", { count: length, target: question.lengthValue, unit: tw(`questions.unit.${question.lengthUnit}`) })}
        </span>
      </div>
      <p className="text-ink-2 text-body-sm" data-testid="writer-evidence-note">
        {t("evidenceNote")}
      </p>

      {editing === null ? (
        <div className="text-body flex flex-col gap-3 leading-relaxed [overflow-wrap:anywhere]" data-testid="writer-version-text">
          {paragraphs.map((paragraph, index) => (
            <p key={index}>
              {paragraph.map(({ sentence, index: at }) => (
                <span key={at}>
                  <button
                    type="button"
                    onClick={() => setOpen(open === at ? null : at)}
                    aria-expanded={open === at}
                    aria-controls="writer-sentence-detail"
                    aria-label={`${sentence.text} (${tw(`status.label.${sentence.status}`)})`}
                    className={cn("hover:bg-soft focus-visible:ring-ring rounded-[3px] text-left underline decoration-2 underline-offset-4 focus-visible:ring-2 focus-visible:outline-none", MARK[sentence.status], open === at && "bg-soft")}
                    data-testid="writer-sentence"
                    data-status={sentence.status}
                  >
                    {sentence.text}
                  </button>{" "}
                </span>
              ))}
            </p>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={editId} className="text-body-sm font-semibold">
            {t("editLabel")}
          </label>
          <Textarea id={editId} value={editing} onChange={(event) => setEditing(event.target.value)} rows={10} data-testid="writer-edit-text" />
          <p className="text-ink-3 text-body-sm">{t("editHint")}</p>
        </div>
      )}

      {detail && editing === null ? <SentenceDetail sentence={detail} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        {editing === null ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => void copy()} data-testid="writer-copy">
              <Copy aria-hidden /> {t("copy")}
            </Button>
            <Button type="button" size="sm" variant={isFinal ? "outline" : "primary"} onClick={toggleFinal} disabled={!enabled || pending} data-testid="writer-finalise" data-final={isFinal}>
              <Check aria-hidden /> {isFinal ? t("unfinalise") : t("finalise")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(version.text)} disabled={!enabled} data-testid="writer-edit">
              <Pencil aria-hidden /> {t("edit")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="primary" onClick={saveEdit} disabled={!enabled || pending || editing.trim() === "" || editing === version.text} data-testid="writer-edit-save">
              {t("editSave")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)} disabled={pending}>
              {t("editCancel")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** One sentence's check: its status in words, what it was checked as, each quote with where it was (not) found, and what to check. */
function SentenceDetail({ sentence }: { sentence: CheckedSentence }) {
  const t = useTranslations("writer.status");
  return (
    <div id="writer-sentence-detail" role="region" aria-live="polite" aria-label={t("detailLabel")} className="bg-soft rounded-card flex min-w-0 flex-col gap-2 px-3 py-2.5 [overflow-wrap:anywhere]" data-testid="writer-sentence-detail" data-status={sentence.status}>
      <p className="text-body-sm">
        <span className="font-semibold">{t(`label.${sentence.status}`)}</span> — {t(`explain.${sentence.status}`)}
      </p>
      <p className="text-ink-3 text-data font-mono">{t("about", { about: t(`aboutKind.${sentence.about}`) })}</p>
      {sentence.evidence.length > 0 ? (
        <ul className="flex flex-col gap-1.5" data-testid="writer-evidence">
          {sentence.evidence.map((entry, index) => (
            <li key={index} className="text-body-sm" data-problem={entry.problem ?? "ok"}>
              <span className="text-ink-3 font-mono text-data">
                {t(`source.${entry.source}`)}
                {entry.ref ? ` · ${entry.ref}` : ""}
              </span>{" "}
              <q className="italic">{entry.quote}</q>
              {entry.problem ? <span className="text-bad block text-data font-mono">{t(`problem.${entry.problem}`)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {sentence.missing.length > 0 ? (
        <p className="text-warning-text text-body-sm" data-testid="writer-missing">
          {t("missing", { items: sentence.missing.join(", ") })}
        </p>
      ) : null}
      {sentence.needsCheck.length > 0 ? (
        <p className="text-warning-text text-body-sm" data-testid="writer-needs-check">
          {t("needsCheck", { items: sentence.needsCheck.join(", ") })}
        </p>
      ) : null}
    </div>
  );
}
