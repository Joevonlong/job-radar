"use client"

import * as React from "react"
import { CheckIcon, MinusIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/** Checkbox (multi-select, saved with a form). `checked="indeterminate"` shows the mixed state. */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-[4px] border-bw border-border bg-card text-hi-ink shadow-e1 transition-colors duration-fast data-[state=checked]:bg-hi data-[state=indeterminate]:bg-hi aria-invalid:border-bad disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="grid place-items-center">
        {props.checked === "indeterminate" ? (
          <MinusIcon className="size-3.5" strokeWidth={3} aria-hidden />
        ) : (
          <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
