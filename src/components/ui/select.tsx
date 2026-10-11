import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { fieldBase, fieldSize, type FieldSize } from "@/components/ui/field-styles"

type SelectProps = Omit<React.ComponentProps<"select">, "size"> & { size?: FieldSize }

/**
 * Native `<select>` styled like the other inputs. A native control keeps keyboard,
 * screen-reader and mobile-picker behaviour for free and works inside plain forms.
 */
function Select({ className, children, size = "md", ...props }: SelectProps) {
  return (
    <div className="relative w-full" data-slot="select-wrapper">
      <select
        data-slot="select"
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
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink"
      />
    </div>
  )
}

export { Select }
