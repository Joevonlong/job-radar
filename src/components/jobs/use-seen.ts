"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { markSeenAction as rawMarkSeenAction, markUnseenAction as rawMarkUnseenAction } from "@/app/visit-actions";
import { forgetSeenNotes, noteSeenLocally, seenNotesSnapshot, subscribeSeenNotes } from "@/lib/dashboard/seen-local";
import { withActionFeedback } from "@/lib/actions/client";

const markSeenAction = withActionFeedback(rawMarkSeenAction)(() => ({ ok: false }));
const markUnseenAction = withActionFeedback(rawMarkUnseenAction)(() => ({ ok: false }));

export interface SeenSubject {
  id: number;
  /** What the server last said; absent = seen. */
  seen?: boolean;
}

const NO_NOTES: ReadonlyMap<number, boolean> = new Map();

/**
 * The seen state of the jobs on screen: what the server sent, with this tab's notes on top (a job opened from the list and
 * seen on its detail page, so "back" shows it before the server answers) and the optimistic change of a row action on top of that.
 * An override is dropped once the server's value agrees with it (or its job left the page); so is a note.
 */
export function useSeenState(subjects: readonly SeenSubject[]) {
  // the server render and hydration see no notes; the browser's notes apply right after
  const notes = useSyncExternalStore(subscribeSeenNotes, seenNotesSnapshot, () => NO_NOTES);
  const [overrides, setOverrides] = useState<ReadonlyMap<number, boolean>>(() => new Map());

  // new rows from the server: keep only the overrides it has not caught up with (adjusted while rendering, not in an effect)
  const [seenSubjects, setSeenSubjects] = useState(subjects);
  if (seenSubjects !== subjects) {
    setSeenSubjects(subjects);
    if (overrides.size > 0) {
      const byId = new Map(subjects.map((s) => [s.id, s.seen !== false]));
      const next = new Map([...overrides].filter(([id, value]) => byId.has(id) && byId.get(id) !== value));
      if (next.size !== overrides.size) setOverrides(next);
    }
  }

  // notes the server agrees with are not needed any more
  useEffect(() => {
    if (notes.size === 0) return;
    forgetSeenNotes(subjects.filter((s) => notes.has(s.id) && notes.get(s.id) === (s.seen !== false)).map((s) => s.id));
  }, [notes, subjects]);

  const isSeen = useCallback((subject: SeenSubject) => overrides.get(subject.id) ?? notes.get(subject.id) ?? subject.seen !== false, [notes, overrides]);

  /** Shows the new state at once and saves it; puts the old one back when the save fails (returns false then). */
  const setSeen = useCallback(async (subject: SeenSubject, seen: boolean): Promise<boolean> => {
    setOverrides((current) => new Map(current).set(subject.id, seen));
    noteSeenLocally(subject.id, seen);
    const result = seen ? await markSeenAction({ jobId: subject.id, via: "action" }) : await markUnseenAction({ jobId: subject.id });
    if (result.ok) return true;
    setOverrides((current) => new Map(current).set(subject.id, !seen));
    noteSeenLocally(subject.id, !seen);
    return false;
  }, []);

  return { isSeen, setSeen };
}
