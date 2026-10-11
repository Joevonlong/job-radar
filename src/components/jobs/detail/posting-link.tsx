"use client";

import { markSeenAction } from "@/app/visit-actions";
import { noteSeenLocally } from "@/lib/dashboard/seen-local";

/** A link to the original posting (opens in a new tab as before); following it (click or middle click) also marks the job seen. */
export function PostingLink({ jobId, href, className, testId, ariaLabel, children }: { jobId: number; href: string; className?: string; testId?: string; ariaLabel?: string; children: React.ReactNode }) {
  const followed = () => {
    noteSeenLocally(jobId, true);
    void markSeenAction({ jobId, via: "source" });
  };
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      data-testid={testId}
      aria-label={ariaLabel}
      onClick={followed}
      // a middle click opens it in a background tab: followed too
      onAuxClick={(event) => {
        if (event.button === 1) followed();
      }}
    >
      {children}
    </a>
  );
}
