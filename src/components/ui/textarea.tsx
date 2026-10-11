import * as React from "react"
import { cn } from "@/lib/utils"
import { fieldBase } from "@/components/ui/field-styles"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        fieldBase,
        "flex field-sizing-content min-h-24 rounded-btn px-3 py-2 text-body",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
