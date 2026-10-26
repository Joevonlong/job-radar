"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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

/** How a tag box treats an entry already in the list: ignore case, compare as typed, or allow repeats. */
export type TagDedupe = "insensitive" | "exact" | "none";

interface TagInputProps {
  id: string;
  values: string[];
  onChange: (next: string[]) => void;
  invalid: boolean;
  describedBy?: string;
  /** `insensitive` (default): trimmed, NFC-normalised and lower-cased before comparing. `exact`: trimmed text must be equal (regexes, numbers). `none`: repeats are allowed. */
  dedupe?: TagDedupe;
  /** A comma ends an entry (default). Off where an entry is a whole sentence or a regex that may contain commas. */
  commitOnComma?: boolean;
}

/** How long the existing chip stays highlighted after a repeated entry was refused. */
const HIGHLIGHT_MS = 1500;
/** The pause between clearing and rewriting the notice, so a screen reader reads the same text again. */
const REANNOUNCE_MS = 60;

function tagKey(value: string, dedupe: TagDedupe): string {
  const trimmed = value.trim();
  return dedupe === "insensitive" ? trimmed.normalize("NFC").toLowerCase() : trimmed;
}

/** A list of short strings: type + Enter (or comma, or leaving the field) adds, the x removes. A repeated entry is not added; the text stays and the existing chip is pointed out. */
export function TagInput({ id, values, onChange, invalid, describedBy: describedByIds, dedupe = "insensitive", commitOnComma = true }: TagInputProps) {
  const t = useTranslations("profile.tags");
  const [pending, setPending] = useState("");
  /** The existing entry the last refused entry matched; shown in the live region. */
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  function clearFeedback() {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    noticeTimer.current = null;
    flashTimer.current = null;
    setDuplicateOf(null);
    setFlash(null);
  }

  function refuse(existing: string, highlight: boolean) {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    if (duplicateOf === existing) {
      // same repeat again: empty the region first so the screen reader reads it again
      setDuplicateOf(null);
      noticeTimer.current = setTimeout(() => setDuplicateOf(existing), REANNOUNCE_MS);
    } else {
      setDuplicateOf(existing);
    }
    if (highlight) {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      setFlash(existing);
      flashTimer.current = setTimeout(() => setFlash(null), HIGHLIGHT_MS);
    }
  }

  function commit(highlight: boolean) {
    const value = pending.trim();
    if (value === "") {
      setPending("");
      return;
    }
    if (dedupe !== "none") {
      const key = tagKey(value, dedupe);
      const existing = values.find((v) => tagKey(v, dedupe) === key);
      if (existing !== undefined) {
        // keep what was typed: the user may want to edit it into something new
        refuse(existing, highlight);
        return;
      }
    }
    clearFeedback();
    setPending("");
    onChange([...values, value]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // an input method uses Enter / comma / Backspace for its own candidates (Safari reports only keyCode 229)
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" || (commitOnComma && event.key === ",")) {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Backspace" && pending === "" && values.length > 0) {
      clearFeedback();
      onChange(values.slice(0, -1));
    }
  }

  const noticeValue = duplicateOf !== null && values.includes(duplicateOf) ? duplicateOf : null;
  const flashIndex = flash !== null ? values.indexOf(flash) : -1;

  return (
    <div className="flex flex-col gap-2">
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((value, index) => (
            <li key={`${value}-${index}`} className="max-w-full">
              {/* a long entry (a scoring criterion is a whole sentence) wraps inside the chip instead of being cut off */}
              <FilterChip
                className={`h-auto min-h-7 max-w-full py-0.5${index === flashIndex ? " outline-signal-t4 outline-[3px] outline-offset-2" : ""}`}
                data-highlighted={index === flashIndex ? "" : undefined}
                removeLabel={t("remove", { value })}
                onRemove={() => {
                  clearFeedback();
                  onChange(values.filter((_, i) => i !== index));
                }}
              >
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
        onChange={(event) => {
          if (duplicateOf !== null) clearFeedback();
          setPending(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(false)}
      />
      {/* always mounted with a reserved line, so a notice does not move the form; the input is not tied to it (it would be read twice) */}
      <p id={`${id}-duplicate`} aria-live="polite" className="text-ink-2 text-body-sm min-h-5" data-testid="tag-duplicate">
        {noticeValue !== null ? t("duplicate", { value: noticeValue }) : ""}
      </p>
    </div>
  );
}
