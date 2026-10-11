"use client"

import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { LayoutGroup, motion, slideTransition, useReducedMotion } from "@/components/viz/motion"
import { cn } from "@/lib/utils"

/*
 * Segmented control (2-5 views, tokens.md "选择控件"). Radiogroup semantics through Radix: the selected segment is the
 * tab stop and the arrow keys move and select. The selected block is a Motion `layoutId` indicator rendered inside the
 * checked segment, so it glides from the old segment to the new one (viz/motion.tsx wrappers; --dur-base, spring ease).
 * It is part of the server render, so there is no flash; with reduced motion it jumps instead of sliding.
 *
 *   <Segmented aria-label="View" value={view} onValueChange={setView}>
 *     <SegmentedItem value="list">List</SegmentedItem>
 *     <SegmentedItem value="board" count={12}>Board</SegmentedItem>
 *   </Segmented>
 */
type SegmentedProps = Omit<React.ComponentProps<typeof RadioGroupPrimitive.Root>, "orientation">

const SegmentedContext = React.createContext<{ value: string; id: string }>({ value: "", id: "" })

function Segmented({
  className,
  children,
  value: valueProp,
  defaultValue,
  onValueChange,
  ...props
}: SegmentedProps) {
  const [inner, setInner] = React.useState(defaultValue ?? "")
  const value = valueProp ?? inner
  const id = React.useId()

  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented"
      orientation="horizontal"
      value={value}
      onValueChange={(next) => {
        if (valueProp === undefined) setInner(next)
        onValueChange?.(next)
      }}
      className={cn(
        "group/seg relative inline-flex w-fit rounded-btn border-bw border-border bg-card shadow-e2",
        className
      )}
      {...props}
    >
      <SegmentedContext.Provider value={{ value, id }}>
        <LayoutGroup id={id}>{children}</LayoutGroup>
      </SegmentedContext.Provider>
    </RadioGroupPrimitive.Root>
  )
}

function SegmentedItem({
  className,
  children,
  count,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & { count?: number }) {
  const { value, id } = React.useContext(SegmentedContext)
  const reduced = useReducedMotion()
  const checked = props.value === value
  return (
    <RadioGroupPrimitive.Item
      data-slot="segmented-item"
      className={cn(
        "relative z-10 inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-label font-bold whitespace-nowrap text-ink transition-colors duration-base",
        "border-l-bw border-border first:rounded-l-[calc(var(--r-btn)-var(--bw))] first:border-l-0 last:rounded-r-[calc(var(--r-btn)-var(--bw))]",
        "focus-visible:outline-offset-[-3px]",
        "data-[state=checked]:text-paper",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    >
      {checked ? (
        <motion.span
          aria-hidden
          layoutId={`${id}-slider`}
          data-slot="segmented-slider"
          className="pointer-events-none absolute inset-0 -z-10 rounded-[calc(var(--r-btn)-var(--bw))] bg-ink"
          transition={slideTransition(reduced)}
        />
      ) : null}
      {children}
      {count != null ? (
        <b className="font-mono text-data-sm font-semibold tabular-nums opacity-70">{count}</b>
      ) : null}
    </RadioGroupPrimitive.Item>
  )
}

export { Segmented, SegmentedItem }
