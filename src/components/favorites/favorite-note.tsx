"use client";

import { Star } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { saveFavoriteNoteAction } from "@/app/favorites/actions";
import { Input } from "@/components/ui/input";
import { FAVORITE_NOTE_MAX_CHARS } from "@/lib/dashboard/limits";
import { toastTone } from "@/lib/toast";

interface FavoriteNoteProps {
  jobId: number;
  title: string;
  note: string | null;
  /** "3 days ago" and the absolute time, formatted on the server. */
  starredLabel: string;
  starredTitle: string;
}

/**
 * The line under a row on the favorites page: "★ starred 3 days ago · note". The note text (or "Add note") turns into a one-line
 * input: Enter or leaving it saves, Esc cancels. Clicks inside never open the job behind the row.
 */
export function FavoriteNote({ jobId, title, note, starredLabel, starredTitle }: FavoriteNoteProps) {
  const t = useTranslations("favorites");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ source: string | null; value: string | null }>({ source: note, value: note });
  // the server's note replaced ours (a refresh brought a newer one): follow it
  const value = shown.source === note ? shown.value : note;
  const cancelled = useRef(false);
  const saving = useRef(false);

  const start = () => {
    cancelled.current = false;
    setDraft(value ?? "");
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (cancelled.current || saving.current) return;
    const next = draft.trim();
    if (next.length > FAVORITE_NOTE_MAX_CHARS) {
      setError(t("note.tooLong", { max: FAVORITE_NOTE_MAX_CHARS }));
      return;
    }
    if (next === (value ?? "")) {
      setEditing(false);
      return;
    }
    saving.current = true;
    const result = await saveFavoriteNoteAction({ jobId, note: next });
    saving.current = false;
    if (!result.ok) {
      setError(t(result.error === "invalid" ? "note.tooLong" : `toast.error.${result.error}`, { max: FAVORITE_NOTE_MAX_CHARS }));
      return;
    }
    setShown({ source: note, value: result.note });
    setEditing(false);
    toastTone("success", t("note.saved"));
  };

  return (
    <div className="jb-fav" data-slot="fav-note" data-editing={editing ? "" : undefined} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <span className="inline-flex shrink-0 items-center gap-1" title={starredTitle}>
        <Star aria-hidden className="fill-hi stroke-ink size-3" /> {t("starredAt", { time: starredLabel })}
      </span>
      {editing ? null : <span aria-hidden>·</span>}
      {editing ? (
        <span className="flex min-w-0 basis-full flex-col gap-0.5" data-slot="fav-note-edit-field">
          <Input
            autoFocus
            value={draft}
            maxLength={FAVORITE_NOTE_MAX_CHARS + 20}
            className="h-ctl-sm w-full"
            placeholder={t("note.placeholder")}
            aria-label={t("note.label", { title })}
            aria-invalid={error ? true : undefined}
            data-testid="fav-note-input"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelled.current = true;
                setEditing(false);
              }
            }}
            onBlur={() => void save()}
          />
          {error ? (
            <span role="alert" className="text-destructive text-data" data-testid="fav-note-error">
              {error}
            </span>
          ) : null}
        </span>
      ) : (
        <button type="button" className="-my-sp-1 min-h-sp-6 min-w-0 truncate py-sp-1 text-left underline-offset-4 hover:underline focus-visible:underline" onClick={start} data-testid="fav-note-edit" title={t("note.edit", { title })}>
          {value ? value : <span className="text-ink-3">{t("note.add")}</span>}
        </button>
      )}
    </div>
  );
}
