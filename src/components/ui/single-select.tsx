"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { fieldBase, fieldSize } from "@/components/ui/field-styles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface SingleSelectOption {
  value: string
  label: string
}

export interface SingleSelectProps {
  /** Field name; shown above the trigger (popover) or inside the row (inline) and used as the accessible name. */
  label: string
  options: readonly SingleSelectOption[]
  value: string
  onChange: (next: string) => void
  /** `popover`: a floating list under the trigger (desktop). `inline`: a full-width row that unfolds the list in place (the phone sheet). */
  layout: "popover" | "inline"
  /** Inline layout only: the list is unfolded (the caller keeps one open at a time). */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Trigger: `testId` (with `data-value`); options: `${testId}-option` with `data-value`. */
  testId: string
  className?: string
}

const labelClass = "text-muted-foreground flex min-w-0 flex-col gap-1 text-xs"

function PopoverSingleSelect({ label, options, value, onChange, testId, className }: SingleSelectProps) {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <div className={cn(labelClass, className)} data-slot="single-select-field">
      <span>{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`${label}: ${current?.label ?? value}`}
            data-testid={testId}
            data-value={value}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault()
                setOpen(true)
              }
            }}
            className={cn(fieldBase, fieldSize({ size: "md" }), "flex cursor-pointer items-center justify-between gap-sp-2 text-left")}
          >
            <span className="min-w-0 truncate">{current?.label ?? value}</span>
            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-slot="single-select"
          className="flex w-(--radix-popover-trigger-width) min-w-48 max-w-80 flex-col"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            rootRef.current?.focus()
          }}
        >
          <CommandPrimitive ref={rootRef} label={label} tabIndex={-1} value={value} className="flex min-h-0 flex-1 flex-col outline-hidden">
            <CommandPrimitive.List className="max-h-80 overflow-x-hidden overflow-y-auto p-1">
              {options.map((option) => {
                const checked = option.value === value
                return (
                  <CommandPrimitive.Item
                    key={option.value}
                    value={option.value}
                    onSelect={() => pick(option.value)}
                    aria-checked={checked}
                    data-slot="command-item"
                    data-testid={`${testId}-option`}
                    data-value={option.value}
                    data-checked={checked}
                    className="relative flex cursor-pointer items-center gap-sp-2 rounded-tag px-2.5 py-1.5 text-body font-medium outline-hidden select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    <CheckIcon aria-hidden className={cn("size-4 shrink-0", !checked && "invisible")} />
                  </CommandPrimitive.Item>
                )
              })}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function InlineSingleSelect({ label, options, value, onChange, testId, className, expanded = false, onExpandedChange }: SingleSelectProps) {
  const regionId = React.useId()
  const current = options.find((o) => o.value === value)

  return (
    <div className={cn("flex flex-col gap-sp-2", className)} data-slot="single-select-field">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={expanded}
        aria-controls={regionId}
        aria-label={`${label}: ${current?.label ?? value}`}
        data-testid={testId}
        data-value={value}
        onClick={() => onExpandedChange?.(!expanded)}
        className={cn(fieldBase, "flex min-h-ctl-lg cursor-pointer items-center justify-between gap-sp-2 rounded-btn px-3 text-left text-body")}
      >
        <span className="text-ink-2 text-body-sm shrink-0">{label}</span>
        <span className="flex min-w-0 items-center gap-sp-2">
          <span className="min-w-0 truncate">{current?.label ?? value}</span>
          <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 transition-transform duration-fast motion-reduce:transition-none", expanded && "rotate-180")} />
        </span>
      </button>
      {expanded ? (
        <ul id={regionId} role="listbox" aria-label={label} data-slot="single-select" className="border-bw border-border bg-card rounded-card p-sp-2">
          {options.map((option) => {
            const checked = option.value === value
            return (
              <li key={option.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={checked}
                  data-testid={`${testId}-option`}
                  data-value={option.value}
                  data-checked={checked}
                  onClick={() => {
                    onChange(option.value)
                    onExpandedChange?.(false)
                  }}
                  className="flex min-h-ctl-lg w-full cursor-pointer items-center gap-sp-3 rounded-tag px-2 text-left text-body font-medium hover:bg-soft"
                >
                  <span className="min-w-0 flex-1 break-words">{option.label}</span>
                  <CheckIcon aria-hidden className={cn("size-4 shrink-0", !checked && "invisible")} />
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Pick exactly one value from a fixed list. Same look as `MultiSelect` (trigger, popover, phone-sheet row); the caller
 * owns the value, selecting closes the list.
 */
function SingleSelect(props: SingleSelectProps) {
  return props.layout === "inline" ? <InlineSingleSelect {...props} /> : <PopoverSingleSelect {...props} />
}

export { SingleSelect }
