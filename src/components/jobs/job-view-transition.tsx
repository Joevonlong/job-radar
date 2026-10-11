import { ViewTransition } from "react";
import type { ReactNode } from "react";

import "./view-transition.css";
import { jobViewTransitionName, type JobViewTransitionPart } from "./view-transition";

/**
 * Marks the element(s) inside as the shared element `part` of job `id` (React `<ViewTransition>`, which Next.js drives on
 * every App Router navigation; no configuration). `default="none"` keeps the element still on unrelated transitions,
 * `share="morph"` is the class `view-transition.css` styles. A browser without View Transitions renders the children
 * as they are. Reduced motion: the tokens set the duration to 0 (view-transition.css).
 *
 * The list rows wrap their title and rank cell the same way: `<JobViewTransition id={job.id} part="title">`.
 */
export function JobViewTransition({ id, part, children }: { id: string | number; part: JobViewTransitionPart; children: ReactNode }) {
  return (
    <ViewTransition name={jobViewTransitionName(id, part)} share="morph" default="none">
      {children}
    </ViewTransition>
  );
}
