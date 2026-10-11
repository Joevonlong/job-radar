import * as React from "react"

import { ButtonBase, type ButtonProps } from "@/components/ui/button-base"
import { buttonVariants } from "@/components/ui/button-variants"

/*
 * Button entry point. Stays free of "use client" so server components can keep calling `buttonVariants()` (link
 * styled as a button) and rendering <Button>; the stateful part lives in button-base.tsx.
 */
function Button(props: ButtonProps) {
  return <ButtonBase {...props} />
}

export { Button, buttonVariants }
export type { ButtonProps }
