"use client"

import * as React from "react"
import { type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { buttonVariants } from "@/components/ui/button-variants"
import { cn } from "@/lib/utils"

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Shows a spinner, disables the button and sets aria-busy. The caller passes the in-progress label as children. */
    loading?: boolean
    /** Key hint rendered at the end of the label, e.g. kbd="N". */
    kbd?: string
  }

/** Client half of Button (needs state to keep the width while loading). Import `Button` from "@/components/ui/button". */
export function ButtonBase({
  className,
  variant = "default",
  size = "md",
  asChild = false,
  loading = false,
  kbd,
  children,
  disabled,
  ref,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button"
  const innerRef = React.useRef<HTMLButtonElement | null>(null)
  const idleWidth = React.useRef(0)

  // Width stays stable: while idle remember the width; when loading starts, hold it as a floor (set before paint).
  React.useLayoutEffect(() => {
    const node = innerRef.current
    if (!node) return
    if (!loading) {
      node.style.removeProperty("min-width")
      idleWidth.current = node.getBoundingClientRect().width
    } else if (idleWidth.current) {
      node.style.minWidth = `${Math.ceil(idleWidth.current)}px`
    }
  })

  const setRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      innerRef.current = node
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  const content = asChild ? (
    children
  ) : (
    <>
      {loading ? <span aria-hidden data-slot="button-spinner" className="spin-ring size-3.5 shrink-0" /> : null}
      {children}
      {kbd ? (
        <kbd
          aria-hidden
          data-slot="button-kbd"
          className="rounded-[5px] border-[1.5px] border-b-[3px] border-ink bg-card-bg px-1 font-mono text-data-sm font-semibold text-ink"
        >
          {kbd}
        </kbd>
      ) : null}
    </>
  )

  return (
    <Comp
      ref={setRef}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      aria-keyshortcuts={kbd}
      disabled={asChild ? undefined : disabled || loading}
      aria-disabled={asChild && (disabled || loading) ? true : undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {content}
    </Comp>
  )
}
