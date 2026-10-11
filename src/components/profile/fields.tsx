"use client";

import { useTranslations } from "next-intl";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { FilterChip } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { FieldError } from "@/lib/profile/draft";
import type { ProfileActionState, ProfileName } from "@/lib/profile/types";

/** Field errors of the last save of `kind`, keyed by draft path; empty once the file has changed. */
export function fieldErrorMap(state: ProfileActionState, kind: ProfileName, hash: string): Map<string, FieldError> {
  const map = new Map<string, FieldError>();
  if (state.status === "error" && state.kind === kind && state.baseHash === hash) {
    for (const error of state.fieldErrors) if (!map.has(error.path)) map.set(error.path, error);
  }
  return map;
}

export function ErrorText({ id, error, text }: { id: string; error: FieldError | undefined; text?: string }) {
  const t = useTranslations("profile.errors");
  if (text !== undefined) {
    return (
      <p id={id} role="alert" className="text-bad text-body-sm font-bold">
        {text}
      </p>
    );
  }
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-bad text-body-sm font-bold">
      {t(error.key, error.params)}
    </p>
  );
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: FieldError;
  /** An already translated error line, for forms with their own error messages (settings). Wins over `error`. */
  errorText?: string;
  children: ReactNode;
  /** Use a fieldset/legend (groups of controls) instead of a label for one control. */
  group?: boolean;
  /** Keep the label for screen readers only (the surrounding heading already says it). */
  hideLabel?: boolean;
}

/** Label, control, hint and error line. The control must use `aria-describedby={`${id}-msg`}`. */
export function Field({ id, label, hint, error, errorText, children, group = false, hideLabel = false }: FieldProps) {
  const hasError = error !== undefined || errorText !== undefined;
  const body = (
    <>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-ink-2 text-body-sm">
          {hint}
        </p>
      ) : null}
      <ErrorText id={`${id}-msg`} error={error} {...(errorText === undefined ? {} : { text: errorText })} />
    </>
  );
  if (group) {
    return (
      <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={hasError ? `${id}-msg` : hint ? `${id}-hint` : undefined}>
        <legend className={hideLabel ? "sr-only" : "text-label mb-1.5 font-bold"}>{label}</legend>
        {body}
      </fieldset>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-label font-bold">
        {label}
      </label>
      {body}
    </div>
  );
}

export function describedBy(id: string, hasHint: boolean, error: object | string | undefined): string | undefined {
  const ids = [hasHint ? `${id}-hint` : null, error ? `${id}-msg` : null].filter((x): x is string => x !== null);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

interface TagInputProps {
  id: string;
  values: string[];
  onChange: (next: string[]) => void;
  invalid: boolean;
  describedBy?: string;
}

/** A list of short strings: type + Enter (or comma, or leaving the field) adds, the x removes. */
export function TagInput({ id, values, onChange, invalid, describedBy: describedByIds }: TagInputProps) {
  const t = useTranslations("profile.tags");
  const [pending, setPending] = useState("");

  function commit() {
    const value = pending.trim();
    setPending("");
    if (value !== "" && !values.includes(value)) onChange([...values, value]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && pending === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <li key={`${value}-${index}`} className="max-w-full">
              {/* a long entry (a scoring criterion is a whole sentence) wraps inside the chip instead of being cut off */}
              <FilterChip className="h-auto min-h-7 max-w-full py-0.5" removeLabel={t("remove", { value })} onRemove={() => onChange(values.filter((_, i) => i !== index))}>
                <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
              </FilterChip>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        id={id}
        value={pending}
        placeholder={t("placeholder")}
        aria-invalid={invalid || undefined}
        aria-describedby={describedByIds}
        autoComplete="off"
        onChange={(event) => setPending(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </div>
  );
}
