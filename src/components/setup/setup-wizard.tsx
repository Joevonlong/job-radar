"use client";

import { Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";

import { skipWizardAction as rawSkipWizardAction } from "@/app/setup/actions";
import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import type { MarketView } from "@/lib/market/view";
import type { ControlStatus } from "@/lib/settings/status-schema";
import type { SetupStepId } from "@/lib/setup/steps";
import type { SetupView } from "@/lib/setup/view";
import { toastTone } from "@/lib/toast";
import { cn } from "@/lib/utils";

import { StepAi } from "./step-ai";
import { StepHeadingContext } from "./step-frame";
import { StepLanguage } from "./step-language";
import { StepMarket } from "./step-market";
import { StepProfile } from "./step-profile";
import { StepReview } from "./step-review";
import { StepSources } from "./step-sources";
import { StepTargets } from "./step-targets";
import { StepTelegram } from "./step-telegram";
import { Stepper } from "./stepper";
import { withActionFeedback } from "@/lib/actions/client";

const skipWizardAction = withActionFeedback(rawSkipWizardAction)(() => ({ status: "error", step: "review", fieldErrors: [], formError: "writeFailed", nonce: Date.now() }));

interface SetupWizardProps {
  view: SetupView;
  step: SetupStepId;
  market: MarketView;
  status: ControlStatus | null;
}

/** "Skip the wizard, I'll configure it myself" with an inline confirmation (it is undone by opening /setup again). */
function SkipWizard() {
  const t = useTranslations("setup.actions");
  const tForm = useTranslations("setup.formErrors");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);
  const skip = () =>
    startTransition(async () => {
      const result = await skipWizardAction();
      if (result.status === "error") {
        setFailed(true);
        return;
      }
      toastTone("info", t("skippedWizardToast"));
      router.push("/");
    });
  return (
    <div className="flex flex-col items-start gap-sp-2" data-testid="setup-skip-wizard">
      {confirming ? (
        <div role="group" aria-label={t("skipWizard")} className="flex flex-col gap-sp-2 rounded-card border-bw border-border bg-card p-sp-3 shadow-e2">
          <p className="text-body-sm">{t("skipWizardConfirm")}</p>
          <div className="flex flex-wrap gap-sp-2">
            <Button type="button" variant="ink" size="sm" disabled={pending} onClick={skip} data-testid="setup-skip-wizard-confirm">
              {t("skipWizardYes")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="link" size="sm" onClick={() => setConfirming(true)} data-testid="setup-skip-wizard-button">
          {t("skipWizard")}
        </Button>
      )}
      {failed ? (
        <p role="alert" className="text-body-sm font-bold text-bad">
          {tForm("setupUnreadable")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The first-run setup wizard. One step at a time (`?step=`); each step saves into the config files and moves on.
 * After a step change the focus goes to the new step's heading. While the setup is pending every page leads here; once
 * it is complete this page is a review: no redirect, changes apply immediately.
 */
export function SetupWizard({ view, step, market, status }: SetupWizardProps) {
  const t = useTranslations("setup");
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const shownStep = useRef(step);

  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  let body;
  switch (step) {
    case "language":
      body = <StepLanguage view={view.language} />;
      break;
    case "market":
      body = <StepMarket view={view.market} done={view.steps.market.status !== null} market={market} />;
      break;
    case "profile":
      body = <StepProfile view={view.profile} done={view.steps.profile.status !== null} />;
      break;
    case "targets":
      body = <StepTargets view={view.targets} market={market} />;
      break;
    case "sources":
      body = <StepSources view={view.sources} done={view.steps.sources.status === "done"} />;
      break;
    case "ai":
      body = <StepAi view={view.ai} />;
      break;
    case "telegram":
      body = <StepTelegram view={view.telegram} />;
      break;
    case "review":
      body = <StepReview view={view} status={status} />;
      break;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-sp-6" data-testid="setup-wizard" data-pending={view.pending} data-step={step}>
      <header className="flex flex-col gap-sp-1">
        <p className="font-mono text-data font-semibold tracking-wider text-ink-2 uppercase">{t("header.eyebrow")}</p>
        <h1 className="font-display text-h1">{t("header.title")}</h1>
        <p className="max-w-prose text-body text-ink-2">{t("header.intro")}</p>
      </header>
      {view.pending ? null : (
        <p role="status" className="flex items-start gap-sp-2 rounded-card border-bw border-border bg-soft px-sp-3 py-sp-2 text-body-sm font-bold" data-testid="setup-review-note">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t("header.reviewNote")}
        </p>
      )}
      {view.stateError !== null ? (
        <p role="alert" className="flex items-start gap-sp-2 rounded-card border-bw border-bad bg-card px-sp-3 py-sp-2 text-body-sm font-bold">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
          {t("header.stateError", { error: view.stateError })}
        </p>
      ) : null}
      <Stepper current={step} steps={view.steps} />
      <StepHeadingContext.Provider value={headingRef}>
        <div key={step} className={cn("animate-in fade-in-0 duration-base motion-reduce:animate-none")}>
          {body}
        </div>
      </StepHeadingContext.Provider>
      {view.pending ? (
        <SkipWizard />
      ) : step === "review" ? null : (
        <Link href="/" className={cn(INK_LINK, "w-fit text-body-sm")} data-testid="setup-close">
          {t("actions.close")}
        </Link>
      )}
    </div>
  );
}
