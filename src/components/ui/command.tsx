"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { cn } from "@/lib/utils"
import { Kbd } from "@/components/ui/kbd"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-card bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = true,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  /** Runs when the dialog has closed and focus is about to move back (there is no Trigger to give it to). */
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"]
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {/* Inside the content, so the title exists only while the dialog is open (not as an h2 before the page's h1). */}
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex h-12 items-center gap-sp-2 border-b-bw border-border px-sp-3 font-mono"
    >
      {/* terminal prompt instead of a magnifier; Esc is a hint (the dialog handles the key) */}
      <span aria-hidden className="font-bold text-ink">
        &gt;
      </span>
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-10 w-full rounded-btn bg-transparent py-3 text-body outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      <Kbd aria-hidden className="max-sm:hidden">
        Esc
      </Kbd>
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-sp-6 text-center font-mono text-data text-ink-2"
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-cap [&_[cmdk-group-heading]]:text-cap-style [&_[cmdk-group-heading]]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 h-[1.5px] bg-grid", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-sp-2 rounded-tag px-2.5 py-1.5 text-body font-medium outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto font-mono text-data-sm tracking-widest text-ink-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
}
