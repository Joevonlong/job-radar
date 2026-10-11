"use client";

import { useTranslations } from "next-intl";
import { useId, useTransition, type FormEvent, type ReactNode } from "react";

import { SaveBar } from "@/components/settings/save-bar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProfileActionState, ProfileName } from "@/lib/profile/types";

interface FormCardProps {
  kind: ProfileName;
  title: string;
  description: string;
  hash: string;
  state: ProfileActionState;
  pending: boolean;
  /** Number of fields that differ from the saved file (the save bar's unsaved count). */
  dirtyCount: number;
  onSubmit: () => void;
  onReset: () => void;
  children: ReactNode;
}

/** Card + form chrome shared by both profile forms: heading, form-level error, save / reset. */
export function FormCard({ kind, title, description, hash, state, pending, dirtyCount, onSubmit, onReset, children }: FormCardProps) {
  const t = useTranslations("profile");
  const headingId = useId();
  const [, startTransition] = useTransition();
  const formError = state.status === "error" && state.kind === kind && state.baseHash === hash ? state.formError : null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Dispatching inside a transition keeps the typed values: no automatic form reset.
    startTransition(onSubmit);
  }

  return (
    <Card className="gap-4 py-4" data-testid={`${kind}-card`}>
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 id={headingId}>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <form noValidate aria-labelledby={headingId} onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4 px-4 md:px-5">
          {children}
          {formError ? (
            <p role="alert" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
              {t(`formErrors.${formError}`)}
            </p>
          ) : null}
        </CardContent>
        <SaveBar
          floating
          dirtyCount={dirtyCount}
          pending={pending}
          onRevert={onReset}
          labels={{ dirty: (count) => t("actions.dirtyCount", { count }), clean: t("actions.clean"), save: t("actions.save"), saving: t("actions.saving"), revert: t("actions.reset") }}
        />
      </form>
    </Card>
  );
}
