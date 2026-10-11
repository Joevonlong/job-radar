"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Switch (immediate effect, tokens.md "选择控件"). Radix renders role="switch" with aria-checked; the caller supplies
 * the accessible name (aria-label or an associated <label>).
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer items-center rounded-pill border-bw border-border bg-card transition-colors duration-base data-[state=checked]:bg-good disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[18px] translate-x-0.5 rounded-pill border-bw border-border bg-card transition-transform duration-base ease-spring data-[state=checked]:translate-x-[20px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
