import * as React from "react"

import { cn } from "@/lib/utils"

/** A key cap: mono, 3px bottom edge (design system v3 "快捷键"). */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "rounded-[5px] border-[1.5px] border-b-[3px] border-ink bg-card-bg px-1 font-mono text-data-sm font-semibold text-ink",
        className
      )}
      {...props}
    />
  )
}

export { Kbd }
