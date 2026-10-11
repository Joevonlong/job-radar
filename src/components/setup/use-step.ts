"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { saveSetupStepAction, skipSetupStepAction } from "@/app/setup/actions";
import type { FieldError } from "@/lib/profile/draft";
import { toastTone } from "@/lib/toast";
import { nextStepOf, type SetupStepId } from "@/lib/setup/steps";
import { IDLE_SETUP_STATE, type SetupActionState, type SetupFieldError } from "@/lib/setup/types";

/** The URL of a step of the wizard. */
export const stepHref = (step: SetupStepId): string => `/setup?step=${step}`;

export interface StepErrors {
  /** A profile-field error (rendered with the profile page's messages through `Field`'s `error`). */
  profile: (path: string) => FieldError | undefined;
  /** A wizard-field error, already translated. */
  text: (path: string) => string | undefined;
  /** Any error on `path`. */
  has: (path: string) => boolean;
}

/**
 * Save / skip of one step: calls the Server Action, toasts, and moves on to the next step (the page re-reads the files,
 * so the next step shows what is on disk now).
 */
export function useStep(step: SetupStepId) {
  const router = useRouter();
  const t = useTranslations("setup");
  const tErrors = useTranslations("setup.errors");
  const [state, setState] = useState<SetupActionState>(IDLE_SETUP_STATE);
  const [pending, startTransition] = useTransition();
  const next = nextStepOf(step);
  const name = t(`steps.${step}.name`);

  const go = (target: SetupStepId | null): void => {
    if (target !== null) router.push(stepHref(target));
    else router.refresh();
  };

  const save = (input: unknown): void =>
    startTransition(async () => {
      const result = await saveSetupStepAction(step, input);
      setState(result);
      if (result.status === "saved") {
        toastTone("success", t("actions.savedToast", { step: name }), { id: `setup-${step}-${result.nonce}` });
        go(next);
      }
    });

  const skip = (): void =>
    startTransition(async () => {
      const result = await skipSetupStepAction(step);
      setState(result);
      if (result.status === "skipped") {
        toastTone("info", t("actions.skippedToast", { step: name }), { id: `setup-skip-${step}-${result.nonce}` });
        go(next);
      }
    });

  const fieldErrors: SetupFieldError[] = state.status === "error" ? state.fieldErrors : [];
  const errors: StepErrors = {
    profile: (path) => {
      const found = fieldErrors.find((e) => e.ns === "profile" && e.path === path);
      return found && found.ns === "profile" ? { path: found.path, key: found.key, ...(found.params ? { params: found.params } : {}) } : undefined;
    },
    text: (path) => {
      const found = fieldErrors.find((e) => e.ns === "setup" && e.path === path);
      return found && found.ns === "setup" ? tErrors(found.key, { message: "", model: "", ...found.params }) : undefined;
    },
    has: (path) => fieldErrors.some((e) => e.path === path),
  };
  const formError = state.status === "error" ? state.formError : null;
  return { state, pending, save, skip, errors, formError, fieldErrors };
}
