"use client";

import { CheckCircle2, CircleAlert, Loader2, Pencil, Play, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { finishSetupAction as rawFinishSetupAction, runFirstCycleAction as rawRunFirstCycleAction } from "@/app/setup/actions";
import { useControlStatus } from "@/components/settings/use-control-status";
import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import { IDLE_CONTROL_STATE, type ControlActionState } from "@/lib/control/service-types";
import type { ControlStatus } from "@/lib/settings/status-schema";
import { readinessParams } from "@/lib/setup/readiness";
import { SETUP_STEP_IDS } from "@/lib/setup/steps";
import type { SetupFormError } from "@/lib/setup/types";
import type { SetupView } from "@/lib/setup/view";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { StepFrame } from "./step-frame";
import { stepHref } from "./use-step";
import { withActionFeedback } from "@/lib/actions/client";

const finishSetupAction = withActionFeedback(rawFinishSetupAction)(() => ({ status: "error", step: "review", fieldErrors: [], formError: "writeFailed", nonce: Date.now() }));
const runFirstCycleAction = withActionFeedback(rawRunFirstCycleAction)(() => ({ status: "error", error: "databaseUnavailable", nonce: Date.now() }));

const STATUS_ICON = { ok: CheckCircle2, warn: CircleAlert, fail: XCircle } as const;
/** The settings that are not part of the wizard. */
const REVIEW_LINKS = { interests: "/interests", workflow: "/settings?tab=workflow", sources: "/sources", settings: "/settings" } as const;

/** The first cycle: request it, then follow the request through the control status poll. */
function FirstCycle({ initial, disabled }: { initial: ControlStatus | null; disabled: boolean }) {
  const t = useTranslations("setup.review");
  const tRefused = useTranslations("trigger.refused");
  const tCycle = useTranslations("dashboard.cycle");
  const { status, refresh } = useControlStatus(initial);
  const [state, setState] = useState<ControlActionState>(IDLE_CONTROL_STATE);
  const [pending, startTransition] = useTransition();
  const requestId = state.status === "queued" ? state.request : null;
  const request = status?.requests.find((r) => (requestId !== null ? r.id === requestId : r.kind === "run_cycle")) ?? null;
  const open = request !== null && (request.status === "pending" || request.status === "running");

  const run = () =>
    startTransition(async () => {
      setState(await runFirstCycleAction());
      refresh();
    });

  let line: string | null = null;
  if (request !== null && request.kind === "run_cycle") {
    const cycle = request.cycle;
    if (cycle === null) line = open ? t("cycleWaiting") : null;
    else if (cycle.status === "running") line = t("cycleProgress", { id: cycle.id, finished: cycle.runsFinished, total: cycle.runsTotal, fetched: cycle.fetched });
    else line = t("cycleDone", { id: cycle.id, state: tCycle(`state.${cycle.status}`), fetched: cycle.fetched, fresh: cycle.newCount });
  }

  return (
    <section className="flex flex-col gap-sp-2" aria-labelledby="setup-first-cycle" data-testid="setup-first-cycle">
      <div className="flex flex-wrap items-center gap-sp-2">
        <Button type="button" variant="default" size="md" disabled={disabled || pending || open} onClick={run} data-testid="setup-first-cycle-button" id="setup-first-cycle">
          {pending || open ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
          {t("firstCycle")}
        </Button>
      </div>
      <p className="text-body-sm text-ink-2">{t("firstCycleHint")}</p>
      <div aria-live="polite" className="flex flex-col gap-1">
        {state.status === "queued" ? <p className="text-body-sm">{state.existing ? t("firstCycleExisting") : t("firstCycleQueued")}</p> : null}
        {state.status === "error" ? (
          <p role="alert" className="text-body-sm font-bold text-bad">
            {tRefused(state.error, { seconds: state.retryAfterSeconds ?? 0 })}
          </p>
        ) : null}
        {line !== null ? (
          <p className="font-mono text-data" data-testid="setup-first-cycle-progress" data-request={request?.id}>
            {line}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Step 8: what each step did, whether there is enough to collect, the first cycle, and "finish". */
export function StepReview({ view, status }: { view: SetupView; status: ControlStatus | null }) {
  const t = useTranslations("setup");
  const tFields = useTranslations("profile.incomplete");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<SetupFormError | null>(null);

  const finish = (): void =>
    startTransition(async () => {
      const result = await finishSetupAction();
      if (result.status === "error") {
        setFormError(result.formError);
        return;
      }
      toastTone("success", t("actions.finishedToast"));
      router.push("/");
    });

  return (
    <StepFrame step="review" pending={pending} formError={formError} onSkip={() => undefined} onSubmit={finish} submitLabel={view.pending ? t("actions.finish") : t("actions.close")}>
      <section className="flex flex-col gap-sp-2" aria-labelledby="setup-review-steps">
        <h3 id="setup-review-steps" className="text-label font-bold">
          {t("review.stepsTitle")}
        </h3>
        <ul className="grid gap-x-sp-4 gap-y-1 sm:grid-cols-2" data-testid="setup-review-steps">
          {SETUP_STEP_IDS.filter((id) => id !== "review").map((id, index) => {
            const state = view.steps[id].status ?? (view.existingInstall ? "untracked" : "open");
            return (
              <li key={id} className="flex items-center gap-sp-2 text-body-sm" data-step={id} data-state={state}>
                <span aria-hidden className={cn("size-3 shrink-0 rounded-cell border-[1.5px] border-border", state === "done" && "bg-ink", state === "skipped" && "jr-hatch bg-card text-ink-3", (state === "open" || state === "untracked") && "bg-grid")} />
                <span className="min-w-0 flex-1 truncate">
                  {index + 1}. {t(`steps.${id}.name`)}
                </span>
                <span className="font-mono text-data-sm text-ink-2">{t(`review.stepState.${state}`)}</span>
                <Link href={stepHref(id)} className={cn(INK_LINK, "inline-flex items-center")} aria-label={t("review.edit", { step: t(`steps.${id}.name`) })}>
                  <Pencil aria-hidden className="size-3.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-sp-2" aria-labelledby="setup-review-readiness">
        <h3 id="setup-review-readiness" className="text-label font-bold">
          {t("review.readinessTitle")}
        </h3>
        <ul className="flex flex-col gap-sp-1" data-testid="setup-readiness">
          {view.review.readiness.map((item) => {
            const Icon = STATUS_ICON[item.status];
            return (
              <li key={item.id} className="flex items-start gap-sp-2 text-body-sm" data-item={item.id} data-status={item.status}>
                <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", item.status === "ok" && "text-good", item.status === "fail" && "text-bad")} />
                <span className="sr-only">{t(`review.statusLabel.${item.status}`)}: </span>
                <span>{t(`review.readiness.${item.id}`, readinessParams(item, (field) => tFields(`fields.${field}`), tFields("separator")))}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <FirstCycle initial={status} disabled={status === null} />

      <section className="flex flex-col gap-sp-1">
        <p className="text-body-sm text-ink-2">{view.pending ? t("review.finishHint") : null}</p>
        <p className="text-body-sm">{t("review.more")}</p>
        <ul className="flex flex-wrap gap-x-sp-4 gap-y-1" data-testid="setup-review-links">
          {(["interests", "workflow", "sources", "settings"] as const).map((key) => (
            <li key={key} className="text-body-sm">
              {/* while the setup is pending every page leads back here: the names only, links once it is complete */}
              {view.pending ? (
                <span className="font-bold">{t(`review.links.${key}`)}</span>
              ) : (
                <Link href={REVIEW_LINKS[key]} className={INK_LINK}>
                  {t(`review.links.${key}`)}
                </Link>
              )}
            </li>
          ))}
        </ul>
      </section>
    </StepFrame>
  );
}
