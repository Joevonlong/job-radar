"use client";

import { useEffect } from "react";

import { markSeenAction as rawMarkSeenAction } from "@/app/visit-actions";
import { noteSeenLocally } from "@/lib/dashboard/seen-local";
import { withActionFeedback } from "@/lib/actions/client";

const markSeenAction = withActionFeedback(rawMarkSeenAction)(() => ({ ok: false }));

/**
 * The job is on screen, so it is seen. Runs in the browser once the detail page is shown, never while the server renders it:
 * a prefetch of a list link (or any other request for the HTML) marks nothing. The list this tab goes back to learns it at once.
 */
export function SeenTracker({ jobId }: { jobId: number }) {
  useEffect(() => {
    noteSeenLocally(jobId, true);
    void markSeenAction({ jobId, via: "detail" });
  }, [jobId]);
  return null;
}
