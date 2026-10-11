"use client";

import { Kbd } from "@/components/ui/kbd";
import { resolveKeyLabel } from "@/lib/shell/shortcut";
import { cn } from "@/lib/utils";

import { useModifierKey } from "./use-modifier-key";

export interface KeyHint {
  /** Key caps pressed together or in sequence, e.g. ["Mod", "K"] ("Mod" is ⌘ on a Mac and Ctrl elsewhere). */
  keys: readonly string[];
  label: string;
}

interface KeyHintsBarProps {
  hints: readonly KeyHint[];
  /** Accessible name of the bar. */
  label: string;
  className?: string;
}

/** The reminder of list shortcuts at the bottom of a list page: key caps, then what they do. Desktop only (no keyboard on a phone). */
export function KeyHintsBar({ hints, label, className }: KeyHintsBarProps) {
  const modifier = useModifierKey();
  return (
    <div className={cn("mt-sp-3 hidden flex-wrap gap-x-sp-4 gap-y-sp-2 font-mono text-data text-ink-2 md:flex", className)} aria-label={label} role="group">
      {hints.map((hint) => (
        <span key={`${hint.keys.join("+")}-${hint.label}`} className="inline-flex items-center gap-1.5">
          {hint.keys.map((key) => (
            <Kbd key={key}>{resolveKeyLabel(key, modifier)}</Kbd>
          ))}
          {hint.label}
        </span>
      ))}
    </div>
  );
}
