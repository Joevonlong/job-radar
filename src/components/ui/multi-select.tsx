"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { ChevronDownIcon } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"

import { FORMAT_LABELS, resolveLocale } from "@/i18n/locale"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { fieldBase, fieldSize } from "@/components/ui/field-styles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface MultiSelectOption {
  value: string
  label: string
  /** Group heading (e.g. "target cities"); options of one group are kept together, in the order given. */
  group?: string
  /** Selected but no job has it now (an old bookmark): listed first, can be unticked. */
  stale?: boolean
  /** A number shown next to the label (how many jobs); the label alone is what the trigger and the chips show. */
  count?: number
}

export interface MultiSelectProps {
  /** Field name; also the prefix of the trigger's accessible name. */
  label: string
  options: readonly MultiSelectOption[]
  value: readonly string[]
  /** Every toggle. */
  onChange: (next: string[]) => void
  /** The popover closed (or Done was pressed): flush whatever `onChange` debounced. */
  onCommit?: () => void
  searchable?: boolean
  searchPlaceholder?: string
  /** Trigger text when nothing is picked. */
  anyLabel: string
  /** Small line above the list ("matches any of them"). */
  hint?: string
  /**
   * Only this many options are drawn while the search box is empty (the picked and stale ones always are); typing searches all of
   * them. Absent = all. For long lists (the companies) on a phone.
   */
  initialVisible?: number
  /** Small line under the list (e.g. "only the N companies with most jobs are listed"). */
  note?: string
  /** `popover`: a floating list under the trigger (desktop). `inline`: the trigger is a full-width row that unfolds the list in place (the phone sheet, where a popover would sit under the sheet). */
  layout: "popover" | "inline"
  /** Inline layout only: the list is unfolded (the caller keeps one open at a time). */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Trigger: `testId`; options: `${testId}-option` with `data-value`. */
  testId: string
  className?: string
}

/** Lower-case and strip accents, so "munc" finds "München". (Not `foldText` of the filter rules: that module pulls server code into the client bundle.) */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase()
}

const labelClass = "text-muted-foreground flex min-w-0 flex-col gap-1 text-xs"

function useMultiSelectText({ label, options, value, anyLabel }: Pick<MultiSelectProps, "label" | "options" | "value" | "anyLabel">) {
  const t = useTranslations("shell.multiSelect")
  const locale = useLocale()
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v
  const labels = value.map(labelOf)
  const first = labels[0]
  const summary = first === undefined ? anyLabel : labels.length === 1 ? first : t("summaryMore", { first, count: labels.length - 1 })
  const joined = labels.join(FORMAT_LABELS[resolveLocale(locale)].listSeparator)
  const ariaLabel = t("ariaSummary", { label, values: value.length === 0 ? anyLabel : joined })
  return { t, summary, ariaLabel }
}

/** The options to draw: all of them while searching (or without a limit), else the picked / stale ones and the first `limit` others. */
export function visibleOptions(options: readonly MultiSelectOption[], pinned: readonly string[], search: string, limit: number | undefined) {
  if (limit === undefined || search.trim() !== "") return options
  const pinnedSet = new Set(pinned)
  let rest = 0
  return options.filter((o) => o.stale || pinnedSet.has(o.value) || rest++ < limit)
}

/** The job count next to an option's label. */
function OptionCount({ count }: { count: number | undefined }) {
  if (count === undefined) return null
  return (
    <span className="text-ink-3 text-data-sm shrink-0 font-mono font-normal tabular-nums" data-slot="option-count">
      {count}
    </span>
  )
}

/**
 * Options in render order: the values picked when the list opened first (their relative order kept; a stale one is
 * always among them), then the rest in groups in the order their first option appears. `pinned` is a snapshot taken at
 * open, so ticking inside the open list never makes a row jump.
 */
export function arrangeOptions(options: readonly MultiSelectOption[], pinned: readonly string[]) {
  const pinnedSet = new Set(pinned)
  const first = options.filter((o) => o.stale || pinnedSet.has(o.value))
  const rest = options.filter((o) => !(o.stale || pinnedSet.has(o.value)))
  const groups: { heading: string | null; items: MultiSelectOption[] }[] = []
  for (const option of rest) {
    const heading = option.group ?? null
    const group = groups.find((g) => g.heading === heading)
    if (group) group.items.push(option)
    else groups.push({ heading, items: [option] })
  }
  return { stale: first, groups }
}

function PopoverMultiSelect(props: MultiSelectProps) {
  const { label, options, value, onChange, onCommit, searchable = false, searchPlaceholder, hint, note, initialVisible, testId, className } = props
  const { t, summary, ariaLabel } = useMultiSelectText(props)
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const rootRef = React.useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = React.useState<readonly string[]>([])
  const { stale, groups } = arrangeOptions(visibleOptions(options, pinned, search, initialVisible), pinned)

  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  const changeOpen = (next: boolean) => {
    if (next) setPinned(value)
    setOpen(next)
    if (!next) {
      setSearch("")
      onCommit?.()
    }
  }

  const item = (option: MultiSelectOption) => {
    const checked = value.includes(option.value)
    return (
      <CommandPrimitive.Item
        key={option.value}
        value={option.value}
        keywords={[option.label]}
        onSelect={() => toggle(option.value)}
        aria-checked={checked}
        data-slot="command-item"
        data-testid={`${testId}-option`}
        data-value={option.value}
        data-checked={checked}
        className="relative flex cursor-pointer items-center gap-sp-2 rounded-tag px-2.5 py-1.5 text-body font-medium outline-hidden select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
      >
        <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
        {option.stale ? <span className="text-ink-3 text-data-sm shrink-0 font-normal">{t("stale")}</span> : <OptionCount count={option.count} />}
      </CommandPrimitive.Item>
    )
  }

  return (
    <div className={cn(labelClass, className)} data-slot="multi-select-field">
      <span>{label}</span>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={ariaLabel}
            data-testid={testId}
            data-count={value.length}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault()
                changeOpen(true)
              }
            }}
            className={cn(fieldBase, fieldSize({ size: "md" }), "flex cursor-pointer items-center justify-between gap-sp-2 text-left", value.length > 0 && "bg-hi text-hi-ink hover:bg-hi")}
          >
            <span className="min-w-0 truncate">{summary}</span>
            <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          data-slot="multi-select"
          className="flex w-(--radix-popover-trigger-width) min-w-60 max-w-80 flex-col"
          onOpenAutoFocus={(event) => {
            // with a search box the input takes the focus (Radix: first focusable); without one, the list does
            if (!searchable) {
              event.preventDefault()
              rootRef.current?.focus()
            }
          }}
        >
          <CommandPrimitive
            ref={rootRef}
            label={label}
            tabIndex={-1}
            shouldFilter
            filter={(itemValue, query, keywords) => (fold([itemValue, ...(keywords ?? [])].join(" ")).includes(fold(query.trim())) ? 1 : 0)}
            className="flex min-h-0 flex-1 flex-col outline-hidden"
          >
            {hint ? <p className="text-ink-3 border-b-bw border-border px-3 py-1.5 text-data-sm">{hint}</p> : null}
            {searchable ? (
              <div className="border-b-bw border-border p-sp-2">
                <CommandPrimitive.Input
                  value={search}
                  onValueChange={setSearch}
                  placeholder={searchPlaceholder ?? t("search")}
                  aria-label={searchPlaceholder ?? t("search")}
                  autoComplete="off"
                  data-testid={`${testId}-search`}
                  className={cn(fieldBase, fieldSize({ size: "sm" }), "outline-hidden")}
                />
              </div>
            ) : null}
            <CommandPrimitive.List aria-multiselectable="true" className="max-h-80 overflow-x-hidden overflow-y-auto p-1">
              <CommandPrimitive.Empty className="py-sp-4 text-ink-2 text-data text-center font-mono">{t("noMatches")}</CommandPrimitive.Empty>
              {stale.length > 0 ? <CommandPrimitive.Group>{stale.map(item)}</CommandPrimitive.Group> : null}
              {groups.map((group) => (
                <CommandPrimitive.Group
                  key={group.heading ?? "all"}
                  heading={group.heading ?? undefined}
                  className="[&_[cmdk-group-heading]]:text-cap [&_[cmdk-group-heading]]:text-cap-style [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5"
                >
                  {group.items.map(item)}
                </CommandPrimitive.Group>
              ))}
            </CommandPrimitive.List>
            {note ? <p className="text-ink-3 border-t-bw border-border px-3 py-1.5 text-data-sm" data-testid={`${testId}-note`}>{note}</p> : null}
            <div className="border-t-bw border-border flex items-center justify-between gap-sp-2 px-3 py-1.5">
              <span className="text-ink-2 text-data-sm font-mono whitespace-nowrap" aria-live="polite">
                {t("selected", { count: value.length })}
              </span>
              <span className="flex items-center gap-sp-1">
                <Button type="button" variant="ghost" size="sm" disabled={value.length === 0} onClick={() => onChange([])} data-testid={`${testId}-clear`}>
                  {t("clear")}
                </Button>
                <Button type="button" size="sm" onClick={() => changeOpen(false)} data-testid={`${testId}-done`}>
                  {t("done")}
                </Button>
              </span>
            </div>
          </CommandPrimitive>
        </PopoverContent>
      </Popover>
    </div>
  )
}

function InlineMultiSelect(props: MultiSelectProps) {
  const { label, options, value, onChange, onCommit, searchable = false, searchPlaceholder, hint, note, initialVisible, testId, className, expanded = false, onExpandedChange } = props
  const { t, summary, ariaLabel } = useMultiSelectText(props)
  const [search, setSearch] = React.useState("")
  const regionId = React.useId()
  const [pinned, setPinned] = React.useState<readonly string[]>(value)
  const { stale, groups } = arrangeOptions(visibleOptions(options, pinned, search, initialVisible), pinned)
  const needle = fold(search.trim())
  const matches = (o: MultiSelectOption) => needle === "" || fold(`${o.value} ${o.label}`).includes(needle)

  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  const setExpanded = (next: boolean) => {
    if (next) setPinned(value)
    onExpandedChange?.(next)
    if (!next) {
      setSearch("")
      onCommit?.()
    }
  }

  const row = (option: MultiSelectOption) => {
    const checked = value.includes(option.value)
    return (
      <li key={option.value}>
        <label className="flex min-h-ctl-lg cursor-pointer items-center gap-sp-3 rounded-tag px-2 text-body font-medium hover:bg-soft">
          <Checkbox checked={checked} onCheckedChange={() => toggle(option.value)} data-testid={`${testId}-option`} data-value={option.value} />
          <span className="min-w-0 flex-1 break-words">{option.label}</span>
          {option.stale ? <span className="text-ink-3 text-data-sm shrink-0 font-normal">{t("stale")}</span> : <OptionCount count={option.count} />}
        </label>
      </li>
    )
  }
  const shownStale = stale.filter(matches)
  const shownGroups = groups.map((g) => ({ ...g, items: g.items.filter(matches) })).filter((g) => g.items.length > 0)

  return (
    <div className={cn("flex flex-col gap-sp-2", className)} data-slot="multi-select-field">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        aria-label={`${t("expand", { label })} — ${ariaLabel}`}
        data-testid={testId}
        data-count={value.length}
        onClick={() => setExpanded(!expanded)}
        className={cn(fieldBase, "flex min-h-ctl-lg cursor-pointer items-center justify-between gap-sp-2 rounded-btn px-3 text-left text-body", value.length > 0 && "bg-hi text-hi-ink hover:bg-hi")}
      >
        <span className={cn("shrink-0 text-body-sm", value.length > 0 ? "text-hi-ink" : "text-ink-2")}>{label}</span>
        <span className="flex min-w-0 items-center gap-sp-2">
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 transition-transform duration-fast motion-reduce:transition-none", expanded && "rotate-180")} />
        </span>
      </button>
      {expanded ? (
        <div id={regionId} data-slot="multi-select" role="group" aria-label={label} className="border-bw border-border bg-card flex flex-col gap-sp-2 rounded-card p-sp-2">
          <div className="flex items-center justify-between gap-sp-2 px-1">
            <span className="text-ink-3 text-data-sm">{hint}</span>
            <Button type="button" variant="ghost" size="sm" disabled={value.length === 0} onClick={() => onChange([])} data-testid={`${testId}-clear`}>
              {t("clear")}
            </Button>
          </div>
          {searchable ? (
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder ?? t("search")}
              aria-label={searchPlaceholder ?? t("search")}
              autoComplete="off"
              data-testid={`${testId}-search`}
              className={cn(fieldBase, fieldSize({ size: "md" }), "outline-hidden")}
            />
          ) : null}
          <div className="max-h-72 overflow-y-auto">
            {shownStale.length === 0 && shownGroups.length === 0 ? <p className="py-sp-4 text-ink-2 text-data text-center font-mono">{t("noMatches")}</p> : null}
            {shownStale.length > 0 ? <ul>{shownStale.map(row)}</ul> : null}
            {shownGroups.map((group) => (
              <div key={group.heading ?? "all"}>
                {group.heading ? <p className="text-cap text-cap-style text-muted-foreground px-2 py-1.5">{group.heading}</p> : null}
                <ul>{group.items.map(row)}</ul>
              </div>
            ))}
          </div>
          {note ? <p className="text-ink-3 px-1 text-data-sm" data-testid={`${testId}-note`}>{note}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Pick any number of values from a fixed list (OR). One component, two layouts: a popover under the trigger on a desktop,
 * and a row that unfolds in place inside the phone sheet. The caller owns the value (the URL), this only edits it.
 */
function MultiSelect(props: MultiSelectProps) {
  return props.layout === "inline" ? <InlineMultiSelect {...props} /> : <PopoverMultiSelect {...props} />
}

export { MultiSelect }
