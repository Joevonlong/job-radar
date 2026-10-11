import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { fieldBase, fieldSize, type FieldSize } from "@/components/ui/field-styles"

type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> & { size?: FieldSize }

/**
 * A styled native `<select>`: accessible and touch friendly by default, no portal, works without
 * JavaScript. Used for the filters and the status picker.
 */
function NativeSelect({ className, children, size = "md", ...props }: NativeSelectProps) {
  return (
    <div className="relative min-w-0">
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          fieldBase,
          fieldSize({ size }),
          "cursor-pointer appearance-none py-0 pr-8 [&>option]:bg-popover [&>option]:text-popover-foreground",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-ink"
      />
    </div>
  )
}

export { NativeSelect }
