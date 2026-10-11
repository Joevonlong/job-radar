"use client";

import { useEffect, useId, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { lastUnsavedId, registerUnsaved, subscribeUnsaved, unsavedVersion } from "@/lib/shell/unsaved";
import { cn } from "@/lib/utils";

export interface SaveBarLabels {
  /** "3 unsaved" - given the number of changed fields. */
  dirty: (count: number) => string;
  /** Nothing changed. */
  clean: string;
  save: string;
  saving: string;
  revert: string;
}

interface SaveBarProps {
  labels: SaveBarLabels;
  /** Number of fields that differ from the saved file. */
  dirtyCount: number;
  pending: boolean;
  /** Saving is not possible yet (a field has a problem the browser can see); revert still works. */
  blocked?: boolean;
  onRevert: () => void;
  /** Right-hand side: the runner's reload status. */
  status?: ReactNode;
  /**
   * Stick to the bottom of the viewport while the form has unsaved changes (settings, /me, /interests); false = sits in the flow.
   * A clean form's bar never floats (it would only cover content), and when several forms of a page are dirty only the one edited
   * last floats, so two bars never pile up at the bottom edge.
   */
  floating?: boolean;
  saveTestId?: string;
  className?: string;
}

/**
 * The terminal-style save bar (design system "savebar"): amber "N unsaved" count, revert, save, and on the right
 * the runner's status. It lives inside the `<form>`: the save button submits it, so what a save does is the form's
 * business, not the bar's. Always rendered; Save is off while nothing changed. While there are unsaved
 * changes the bar tells the shell's `UnsavedGuard`, which warns before the page is left.
 *
 * `floating` sticks the whole row (`dock`) to the viewport's bottom edge. The dock is a direct child of the `<form>`, so it
 * has the form's whole height to travel in; a sticky box whose parent is only as tall as itself cannot move.
 */
export function SaveBar({ labels, dirtyCount, pending, blocked = false, onRevert, status, floating = false, saveTestId, className }: SaveBarProps) {
  const dirty = dirtyCount > 0;
  const guardId = useId();
  useEffect(() => (dirty ? registerUnsaved(guardId) : undefined), [dirty, guardId]);
  useSyncExternalStore(subscribeUnsaved, unsavedVersion, unsavedVersion);
  const front = lastUnsavedId() === guardId;
  const stuck = floating && dirty && front;
  return (
    <div
      data-testid="save-bar-dock"
      data-floating={stuck ? "true" : "false"}
      className={cn("mt-4 px-4 md:px-5", stuck && "sticky bottom-[calc(var(--spacing-sp-4)+env(safe-area-inset-bottom))] z-sticky")}
    >
      <div
        role="group"
        aria-label={labels.save}
        data-testid="save-bar"
        data-dirty={dirty ? "true" : "false"}
        className={cn(
          "bg-term-bg text-term-ink border-border rounded-card border-bw shadow-e3 flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 font-mono text-data",
          className,
        )}
      >
        <span className={cn("flex items-center gap-1.5 font-semibold", dirty ? "text-term-amber" : "text-term-dim")} data-testid="save-bar-count" role="status">
          <span aria-hidden>{dirty ? "●" : "○"}</span>
          {dirty ? labels.dirty(dirtyCount) : labels.clean}
        </span>
        {status ? <span className="min-w-0 sm:ml-3">{status}</span> : null}
        <span className="ml-auto flex items-center gap-2">
          <Button type="button" size="sm" disabled={pending || !dirty} onClick={onRevert}>
            {labels.revert}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={pending || !dirty || blocked} {...(saveTestId ? { "data-testid": saveTestId } : {})}>
            {pending ? labels.saving : labels.save}
          </Button>
        </span>
      </div>
    </div>
  );
}
