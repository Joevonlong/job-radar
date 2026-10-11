"use client";

import { useTranslations } from "next-intl";
import { useRef, type KeyboardEvent } from "react";

import { SIGNAL_COLORS, signalColorClasses, type SignalColor } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

interface ColorPickerProps {
  /** Id of the group's label (the caller renders it). */
  labelledBy: string;
  value: SignalColor;
  onChange: (color: SignalColor) => void;
  testId?: string;
}

/**
 * The palette of signal category colours as a radio group: one swatch per colour with a 2px ink line, the chosen
 * one lifted with a hard shadow. Arrow keys move the choice (roving tab index), like a native radio group.
 */
export function ColorPicker({ labelledBy, value, onChange, testId }: ColorPickerProps) {
  const t = useTranslations("interests.categories.colors");
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + SIGNAL_COLORS.length) % SIGNAL_COLORS.length;
    const color = SIGNAL_COLORS[next];
    if (color === undefined) return;
    onChange(color);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2" data-testid={testId}>
      {SIGNAL_COLORS.map((color, index) => {
        const checked = color === value;
        return (
          <button
            key={color}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={t(color)}
            title={t(color)}
            tabIndex={checked ? 0 : -1}
            data-color={color}
            onClick={() => onChange(color)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "border-border size-7 cursor-pointer rounded-tag border-bw transition-[transform,box-shadow] duration-fast focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-signal-t4",
              signalColorClasses(color).bg,
              checked ? "shadow-e2 -translate-x-px -translate-y-px" : "shadow-none",
            )}
          >
            {checked ? (
              <span aria-hidden className={cn("text-data-sm font-extrabold", color === "neutral" ? "text-ink" : "text-on-signal")}>
                ✓
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
