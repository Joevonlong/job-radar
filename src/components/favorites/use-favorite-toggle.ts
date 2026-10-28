"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { restoreFavoriteAction as rawRestoreFavoriteAction, setFavoriteAction as rawSetFavoriteAction } from "@/app/favorites/actions";
import { toastTone, toastUndo } from "@/lib/toast";
import { withActionFeedback } from "@/lib/actions/client";

const restoreFavoriteAction = withActionFeedback(rawRestoreFavoriteAction)(() => ({ ok: false, error: "failed" }));
const setFavoriteAction = withActionFeedback(rawSetFavoriteAction)(() => ({ ok: false, error: "failed" }));

export interface FavoriteSubject {
  id: number;
  /** What the server last said. */
  favorite?: boolean;
}

export interface FavoriteToggleOptions {
  /** After the undo brought the star back (the favorites page puts the focus back on the row). */
  onUndone?: (jobId: number) => void;
}

/**
 * The star of the jobs on screen: an optimistic overlay on what the server sent. `toggle` shows the new state at once, asks
 * the server to set it, and puts the old state back with an error toast when that fails. Un-starring offers an undo that restores the
 * note and the time of the star. An override is dropped as soon as the server's value agrees with it (or the job is gone from the page).
 */
export function useFavoriteToggle(subjects: readonly FavoriteSubject[], options: FavoriteToggleOptions = {}) {
  const t = useTranslations("favorites.toast");
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const inFlight = useRef(new Set<number>());
  /** The jobs whose save is on its way (inFlight as state, so a button can say "saving"). */
  const [saving, setSaving] = useState<ReadonlySet<number>>(() => new Set());
  const markSaving = useCallback((id: number, on: boolean) => {
    setSaving((current) => {
      if (current.has(id) === on) return current;
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  /** A press that came while the server was still answering the one before: the last one wins and runs when that answer is in (it was dropped, the star stayed as it was). */
  const queued = useRef(new Map<number, { title: string; next: boolean }>());
  const onUndone = useRef(options.onUndone);
  useEffect(() => {
    onUndone.current = options.onUndone;
  }, [options.onUndone]);

  // an override the server caught up with (or whose job left the page) is not needed any more
  useEffect(() => {
    setOverrides((current) => {
      if (current.size === 0) return current;
      const byId = new Map(subjects.map((s) => [s.id, s.favorite === true]));
      const next = new Map(current);
      for (const [id, value] of current) {
        if (inFlight.current.has(id)) continue;
        if (!byId.has(id) || byId.get(id) === value) next.delete(id);
      }
      return next.size === current.size ? current : next;
    });
  }, [subjects]);

  const setOverride = useCallback((id: number, value: boolean | null) => {
    setOverrides((current) => {
      const next = new Map(current);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });
  }, []);

  const isFavorite = useCallback((subject: FavoriteSubject) => overrides.get(subject.id) ?? subject.favorite === true, [overrides]);

  const toggleRef = useRef<(subject: { id: number; title: string }, next: boolean) => Promise<void>>(async () => {});
  const toggle = useCallback(
    async (subject: { id: number; title: string }, next: boolean) => {
      if (inFlight.current.has(subject.id)) {
        queued.current.set(subject.id, { title: subject.title, next });
        setOverride(subject.id, next);
        return;
      }
      inFlight.current.add(subject.id);
      markSaving(subject.id, true);
      setOverride(subject.id, next);
      try {
        const result = await setFavoriteAction({ jobId: subject.id, favorite: next });
        if (!result.ok) {
          setOverride(subject.id, null);
          toastTone("error", t(`error.${result.error}`));
          return;
        }
        if (next) {
          toastTone("success", t("added", { title: subject.title }));
          return;
        }
        const removed = result.removed;
        if (!removed) {
          toastTone("info", t("removed", { title: subject.title }));
          return;
        }
        toastUndo(
          t("removed", { title: subject.title }),
          async () => {
            setOverride(subject.id, true);
            const restored = await restoreFavoriteAction({ jobId: subject.id, note: removed.note, createdAt: removed.createdAt });
            if (!restored.ok) {
              setOverride(subject.id, null);
              toastTone("error", t(`error.${restored.error}`));
              return;
            }
            onUndone.current?.(subject.id);
          },
          { tone: "info", label: t("undo") },
        );
      } catch {
        setOverride(subject.id, null);
        toastTone("error", t("error.failed"));
      } finally {
        inFlight.current.delete(subject.id);
        markSaving(subject.id, false);
        const again = queued.current.get(subject.id);
        queued.current.delete(subject.id);
        if (again && again.next !== next) void toggleRef.current({ id: subject.id, title: again.title }, again.next);
      }
    },
    [markSaving, setOverride, t],
  );
  useEffect(() => {
    toggleRef.current = toggle;
  }, [toggle]);

  const isSaving = useCallback((subject: { id: number }) => saving.has(subject.id), [saving]);

  return { isFavorite, isSaving, toggle };
}
