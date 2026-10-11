"use client"

import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/** Radio group (2-5 mutually exclusive options). Arrow keys move and select, as native radios do. */
function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />
}

function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "peer grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-pill border-bw border-border bg-card shadow-e1 transition-colors duration-fast aria-invalid:border-bad disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="block size-2 rounded-pill bg-ink" />
    </RadioGroupPrimitive.Item>
  )
}

export { RadioGroup, RadioGroupItem }
