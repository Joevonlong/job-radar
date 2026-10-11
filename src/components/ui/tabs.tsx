"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Tabs as TabsPrimitive } from "radix-ui"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

/*
 * Tabs (tokens.md "选择控件": independent content blocks). `default` = folder tabs on a 2px rule, the active one
 * takes the card fill; `line` = bare tabs with a bar under the active one.
 */
const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-end text-ink-2 group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col group-data-[orientation=vertical]/tabs:items-stretch",
  {
    variants: {
      variant: {
        default: "gap-0 border-b-bw border-border group-data-[orientation=vertical]/tabs:border-r-bw group-data-[orientation=vertical]/tabs:border-b-0",
        line: "gap-1 border-b-bw border-grid bg-transparent",
        // a segmented bar (same look as <Segmented>): one boxed row, the active tab is filled ink; scrolls sideways when it does not fit
        segmented: "max-w-full items-stretch gap-0 overflow-x-auto rounded-btn border-bw border-border bg-card shadow-e2",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex cursor-pointer items-center justify-center gap-1.5 border-bw border-transparent px-3.5 py-2 text-label font-extrabold whitespace-nowrap text-ink-2 transition-colors duration-fast hover:text-ink disabled:pointer-events-none disabled:opacity-45 group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // default: folder tab that sits on the rule (-mb pulls it over the list border)
        "group-data-[variant=default]/tabs-list:-mb-[var(--bw)] group-data-[variant=default]/tabs-list:rounded-t-btn group-data-[variant=default]/tabs-list:border-b-0 group-data-[variant=default]/tabs-list:data-[state=active]:border-border group-data-[variant=default]/tabs-list:data-[state=active]:bg-card group-data-[variant=default]/tabs-list:data-[state=active]:text-ink",
        // segmented: ink fill for the active tab, hairlines between tabs
        "group-data-[variant=segmented]/tabs-list:rounded-none group-data-[variant=segmented]/tabs-list:border-0 group-data-[variant=segmented]/tabs-list:border-l-bw group-data-[variant=segmented]/tabs-list:border-border group-data-[variant=segmented]/tabs-list:py-1.5 group-data-[variant=segmented]/tabs-list:text-ink group-data-[variant=segmented]/tabs-list:first:border-l-0 group-data-[variant=segmented]/tabs-list:data-[state=active]:bg-ink group-data-[variant=segmented]/tabs-list:data-[state=active]:text-paper",
        // line: bar under the active tab
        "group-data-[variant=line]/tabs-list:-mb-[var(--bw)] group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:border-x-0 group-data-[variant=line]/tabs-list:border-t-0 group-data-[variant=line]/tabs-list:data-[state=active]:border-b-border group-data-[variant=line]/tabs-list:data-[state=active]:text-ink",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
