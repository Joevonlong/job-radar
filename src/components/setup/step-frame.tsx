"use client";

import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createContext, useContext, useTransition, type FormEvent, type ReactNode, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { previousStepOf, type SetupStepId } from "@/lib/setup/steps";
import type { SetupFormError } from "@/lib/setup/types";

import { stepHref } from "./use-step";

/** The step heading: the wizard moves focus to it after a step change. */
export const StepHeadingContext = createContext<RefObject<HTMLHeadingElement | null> | null>(null);

interface StepFrameProps {
  step: SetupStepId;
  pending: boolean;
  formError: SetupFormError | null;
  onSubmit: () => void;
  onSkip: () => void;
  /** Saving is impossible (the files cannot be read): only skip / back. */
  disabled?: boolean;
  /** Replaces "Save and continue" (the review step has its own finish). */
  submitLabel?: string;
  /** No save button at all (the review step). */
  hideSubmit?: boolean;
  children: ReactNode;
}

/** Card, heading, the step's form and its footer: back, skip, save and continue. */
export function StepFrame({ step, pending, formError, onSubmit, onSkip, disabled = false, submitLabel, hideSubmit = false, children }: StepFrameProps) {
  const t = useTranslations("setup");
  const headingRef = useContext(StepHeadingContext);
  const headingId = `setup-step-${step}-title`;
  const previous = previousStepOf(step);
  const [, startTransition] = useTransition();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || pending) return;
    startTransition(onSubmit);
  }

  return (
    <Card className="gap-0 py-0" data-testid={`setup-step-${step}`}>
      <CardHeader className="px-4 py-4 md:px-5">
        <CardTitle>
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-display text-h2 outline-none focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-signal-t4" data-testid="setup-step-heading">
            {t(`steps.${step}.title`)}
          </h2>
        </CardTitle>
        <CardDescription>{t(`steps.${step}.description`)}</CardDescription>
      </CardHeader>
      <form noValidate aria-labelledby={headingId} onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-sp-5 px-4 py-5 md:px-5">
          {children}
          {formError ? (
            <p role="alert" className="rounded-tag border-bw border-bad bg-card px-3 py-2 text-body-sm font-bold text-bad" data-testid="setup-form-error">
              {t(`formErrors.${formError}`)}
            </p>
          ) : null}
        </CardContent>
        <div className="flex flex-wrap items-center gap-sp-2 border-t-bw border-border px-4 py-3 md:px-5">
          {previous !== null ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={stepHref(previous)} data-testid="setup-back">
                <ArrowLeft aria-hidden />
                {t("actions.back")}
              </Link>
            </Button>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-sp-2">
            {step !== "review" ? (
              <Button type="button" variant="default" size="md" disabled={pending} onClick={onSkip} data-testid="setup-skip">
                {t("actions.skip")}
              </Button>
            ) : null}
            {hideSubmit ? null : (
              <Button type="submit" variant="primary" size="md" disabled={disabled || pending} aria-busy={pending || undefined} data-testid="setup-save">
                {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
                {pending ? t("actions.saving") : (submitLabel ?? t("actions.saveContinue"))}
                {pending ? null : <ArrowRight aria-hidden />}
              </Button>
            )}
          </div>
        </div>
      </form>
    </Card>
  );
}
