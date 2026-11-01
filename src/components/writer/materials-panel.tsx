"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition, type ReactNode } from "react";

import { breakdownJobAction, breakdownStatusAction } from "@/app/jobs/[id]/breakdown-actions";
import { updateQuestionAction } from "@/app/jobs/[id]/apply/actions";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest } from "@/components/control/use-control-request";
import { Panel } from "@/components/jobs/detail/panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/actions/client";
import { controlQueueViewSchema } from "@/lib/control/request-view-schema";
import { toastTone } from "@/lib/toast";
import { jdMaterialMode, jdPointKey, type JdPoint } from "@/lib/writer/jd-points";
import type { QuestionSelection } from "@/lib/writer/types";
import type { WorkbenchQuestion, WorkbenchView } from "@/lib/writer/view";

const GROUPS = ["must", "nice", "other"] as const;
const groupOf = (point: JdPoint): (typeof GROUPS)[number] => point.requirement ?? "other";

function Group({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <legend className="text-cap text-ink-3 text-cap-style mb-1">{title}</legend>
      {children}
    </fieldset>
  );
}

function Pick({ checked, onChange, disabled, children, testId }: { checked: boolean; onChange: (checked: boolean) => void; disabled: boolean; children: ReactNode; testId?: string }) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} disabled={disabled} className="mt-0.5" data-testid={testId} />
      <label htmlFor={id} className="text-body-sm min-w-0 cursor-pointer [overflow-wrap:anywhere]">
        {children}
      </label>
    </div>
  );
}

/**
 * The material of the selected question: JD points from the breakdown (grouped by must / nice), the JD text itself,
 * the profile, the stories of the experience library and a note on what to stress this time. Every change is saved on
 * the question at once (the emphasis note when it loses focus); nothing is sent before "write".
 */
export function MaterialsPanel({ view, question, enabled, timeZone }: { view: WorkbenchView; question: WorkbenchQuestion | null; enabled: boolean; timeZone: string }) {
  const t = useTranslations("writer.materials");
  const tw = useTranslations("writer");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selection, setSelection] = useState<QuestionSelection | null>(question?.selection ?? null);
  const emphasisId = useId();

  if (!question || !selection) {
    return (
      <Panel id="writer-materials" title={t("title")}>
        <p className="text-ink-2 text-body-sm">{t("noQuestion")}</p>
      </Panel>
    );
  }

  const save = (next: QuestionSelection): void => {
    setSelection(next);
    startTransition(async () => {
      const result = await callAction(() => updateQuestionAction({ jobId: view.job.id, questionId: question.id, selection: next }), () => ({ ok: false as const, error: "failed" as const }));
      if (!result.ok) toastTone("error", tw(`actionError.${result.error}`));
      else router.refresh();
    });
  };
  const chosen = new Set(selection.jdPoints.map(jdPointKey));
  const togglePoint = (point: JdPoint, on: boolean): void => {
    const rest = selection.jdPoints.filter((ref) => jdPointKey(ref) !== jdPointKey(point));
    save({ ...selection, jdPoints: on ? [...rest, { quote: point.quote, offset: point.offset }] : rest });
  };
  const toggleStory = (id: string, on: boolean): void => {
    const rest = selection.storyIds.filter((entry) => entry !== id);
    save({ ...selection, storyIds: on ? [...rest, id] : rest });
  };
  const dropStale = (): void => {
    const points = new Set(view.jdPoints.map(jdPointKey));
    const stories = new Set(view.stories.map((story) => story.id));
    save({ ...selection, jdPoints: selection.jdPoints.filter((ref) => points.has(jdPointKey(ref))), storyIds: selection.storyIds.filter((id) => stories.has(id)) });
  };
  const disabled = !enabled;
  const stale = question.stale.jdPoints + question.stale.stories;

  return (
    <Panel id="writer-materials" title={t("title")}>
      <div className="flex flex-col gap-4" data-testid="writer-materials">
        {stale > 0 ? (
          <div className="text-warning-text text-body-sm flex flex-wrap items-center gap-2" role="status" data-testid="writer-materials-stale">
            <span>{t("stale", { count: stale })}</span>
            <Button type="button" size="sm" variant="outline" onClick={dropStale} disabled={disabled}>
              {t("dropStale")}
            </Button>
          </div>
        ) : null}

        {view.jdPoints.length > 0 ? (
          <div className="flex flex-col gap-3" data-testid="writer-jd-points">
            {view.breakdown === "outdated" ? <p className="text-ink-3 text-body-sm">{t("breakdownOutdated")}</p> : null}
            {GROUPS.map((group) => {
              const points = view.jdPoints.filter((point) => groupOf(point) === group);
              if (points.length === 0) return null;
              return (
                <Group key={group} title={t(`group.${group}`)} testId={`writer-jd-group-${group}`}>
                  {points.map((point) => (
                    <Pick key={jdPointKey(point)} checked={chosen.has(jdPointKey(point))} onChange={(on) => togglePoint(point, on)} disabled={disabled} testId="writer-jd-point">
                      {point.text}
                    </Pick>
                  ))}
                </Group>
              );
            })}
          </div>
        ) : (
          <BreakdownFirst view={view} enabled={enabled} timeZone={timeZone} />
        )}

        {view.job.hasDescription ? (
          <Pick checked={selection.useJdText} onChange={(on) => save({ ...selection, useJdText: on })} disabled={disabled} testId="writer-use-jd-text">
            {t("useJdText")}
          </Pick>
        ) : null}

        <Group title={t("profileGroup")}>
          {view.profile.available ? (
            <Pick checked={selection.profile} onChange={(on) => save({ ...selection, profile: on })} disabled={disabled} testId="writer-use-profile">
              {t("useProfile")}
            </Pick>
          ) : (
            <p className="text-ink-3 text-body-sm">{t("noProfile")}</p>
          )}
        </Group>

        <Group title={t("storiesGroup")} testId="writer-stories">
          {view.storiesUnreadable ? (
            <p className="text-warning-text text-body-sm" role="status" data-testid="writer-stories-unreadable">
              {t("storiesUnreadable")}
            </p>
          ) : view.stories.length === 0 ? (
            <p className="text-ink-3 text-body-sm">{t("noStories")}</p>
          ) : null}
          {view.stories.map((story) => (
            <Pick key={story.id} checked={selection.storyIds.includes(story.id)} onChange={(on) => toggleStory(story.id, on)} disabled={disabled} testId="writer-story">
              <span className="font-semibold">{story.title}</span>
              {story.skills.length > 0 ? <span className="text-ink-3 block font-mono text-data">{story.skills.join(" · ")}</span> : null}
            </Pick>
          ))}
        </Group>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={emphasisId} className="text-cap text-ink-3 text-cap-style">
            {t("emphasisLabel")}
          </label>
          <Textarea
            id={emphasisId}
            value={selection.emphasis}
            onChange={(event) => setSelection({ ...selection, emphasis: event.target.value })}
            onBlur={() => {
              if (selection.emphasis !== question.selection.emphasis) save(selection);
            }}
            maxLength={view.limits.emphasisMaxChars}
            rows={3}
            placeholder={t("emphasisPlaceholder")}
            disabled={disabled}
            data-testid="writer-emphasis"
          />
          <p className="text-ink-3 text-data font-mono">{t("emphasisCount", { count: selection.emphasis.length, max: view.limits.emphasisMaxChars })}</p>
        </div>
      </div>
    </Panel>
  );
}

/** No breakdown yet: offer to make one (the breakdown button of the job page, polled here until it is done). */
function BreakdownFirst({ view, enabled, timeZone }: { view: WorkbenchView; enabled: boolean; timeZone: string }) {
  const t = useTranslations("writer.materials");
  const tb = useTranslations("jdBreakdown");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requestId, setRequestId] = useState<number | null>(null);
  const wait = useControlRequest({
    requestId,
    read: async (id) => {
      const result = await callAction(() => breakdownStatusAction({ jobId: view.job.id, requestId: id }), () => null);
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
      toastTone("error", tb(`error.${error ?? "not_found"}`, { time: "none" }));
    },
  });
  const run = (): void => {
    startTransition(async () => {
      const result = await callAction(() => breakdownJobAction({ jobId: view.job.id }), () => ({ ok: false as const, error: "failed" as const }));
      if (!result.ok) toastTone("error", tb(`error.${result.error}`, { time: "none" }));
      else if (result.queued) setRequestId(result.requestId);
      else router.refresh();
    });
  };
  const busy = pending || requestId !== null;
  const mode = jdMaterialMode({ points: view.jdPoints.length, hasDescription: view.job.hasDescription, breakdownEnabled: view.breakdownEnabled });
  return (
    <div className="border-border rounded-card flex flex-col items-start gap-2 border-dashed border-[1.5px] px-3 py-3" data-testid="writer-breakdown-first">
      <p className="text-ink-2 text-body-sm" data-testid="writer-jd-mode" data-mode={mode}>
        {mode === "no_jd" ? t("noDescription") : mode === "jd_text" ? t("breakdownOff") : t("breakdownFirst")}
      </p>
      {mode === "offer_breakdown" ? (
        <Button type="button" size="sm" onClick={run} disabled={!enabled || busy} aria-busy={busy} data-testid="writer-breakdown-button">
          {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Sparkles aria-hidden />}
          {busy ? tb("requesting") : t("breakdownButton")}
        </Button>
      ) : null}
      {requestId !== null ? <QueueHint queue={wait.queue} stage={wait.stage} timeZone={timeZone} /> : null}
    </div>
  );
}
