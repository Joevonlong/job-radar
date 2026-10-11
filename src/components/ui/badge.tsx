import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { signalColorClasses, type SignalColor } from "@/lib/signals/palette"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

/*
 * Badge base styles (design system v3, tokens.md "标签与徽标"). Business meaning (which tier, which status) is
 * decided by the caller; this file only owns the look.
 *   signal-t1..t4  amber / teal / coral / blue block with ink border (use <SignalTag> for the two-part "[code | name]" form of a signal category)
 *   gate-bad / gate-note / gate-out / gate-warn   hard gate, watch item (dashed), filtered (strikethrough), timeout
 *   skill / skill-hit / skill-miss   mono chips: neutral, matched (hi), missing (dashed, dim)
 *   status / status-on / status-good / status-warn   pill for application status
 *   count / count-hi   number pill      kbd   key cap      filter   removable filter chip look
 * Legacy names (default, secondary, destructive, outline, ghost, link) stay valid for existing callers.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-tag border-bw border-border px-2 text-body-sm font-bold whitespace-nowrap transition-[color,background-color] duration-fast aria-invalid:border-bad [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        // legacy names
        default: "bg-primary text-primary-foreground [a&]:hover:bg-[color-mix(in_srgb,var(--hi)_85%,var(--ink))]",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-grid",
        destructive: "bg-bad text-on-bad [a&]:hover:bg-[color-mix(in_srgb,var(--bad)_85%,var(--ink))]",
        outline: "bg-card text-foreground [a&]:hover:bg-soft",
        ghost: "border-transparent bg-transparent text-foreground [a&]:hover:bg-soft",
        link: "border-transparent bg-transparent text-foreground underline underline-offset-4 [a&]:hover:bg-hi [a&]:hover:text-hi-ink",
        // signal tiers
        "signal-t1": "bg-signal-t1 text-on-signal shadow-e1",
        "signal-t2": "bg-signal-t2 text-on-signal shadow-e1",
        "signal-t3": "bg-signal-t3 text-on-signal shadow-e1",
        "signal-t4": "bg-signal-t4 text-on-signal shadow-e1",
        tag: "bg-soft text-ink shadow-e1",
        // gates
        "gate-bad": "gap-1.5 bg-bad font-extrabold text-on-bad",
        "gate-note": "gap-1.5 border-dashed bg-card font-extrabold text-ink",
        "gate-out": "gap-1.5 bg-ink font-extrabold text-paper line-through",
        "gate-warn": "gap-1.5 bg-warn font-extrabold text-on-signal",
        // skills (mono)
        skill: "rounded-[6px] bg-card px-[7px] font-mono text-data font-semibold text-ink",
        "skill-hit": "rounded-[6px] bg-hi px-[7px] font-mono text-data font-semibold text-hi-ink",
        "skill-miss":
          "rounded-[6px] border-dashed bg-card px-[7px] font-mono text-data font-medium text-ink-3",
        // application status pills
        status: "rounded-pill bg-card px-[9px] font-mono text-data font-bold",
        "status-on": "rounded-pill bg-ink px-[9px] font-mono text-data font-bold text-paper",
        "status-good": "rounded-pill bg-good px-[9px] font-mono text-data font-bold text-on-bad",
        "status-warn": "rounded-pill bg-warn px-[9px] font-mono text-data font-bold text-on-signal",
        // counts
        count:
          "min-w-5 rounded-pill border-transparent bg-ink px-1.5 font-mono text-data-sm font-bold text-paper",
        "count-hi":
          "min-w-5 rounded-pill border-[1.5px] bg-hi px-1.5 font-mono text-data-sm font-bold text-hi-ink",
        // key cap
        kbd: "rounded-[5px] border-[1.5px] border-b-[3px] bg-card px-1.5 font-mono text-data-sm font-semibold text-ink",
        // filter chip look (use <FilterChip> for the removable one)
        filter: "h-7 bg-hi text-body-sm font-bold text-hi-ink",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }

function Badge({ className, variant = "default", asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

/**
 * Two-part signal tag: a block in the category's colour on the left, white name on the right. The block shows the
 * category's code (its id when that is at most 4 characters), else its icon, else nothing (colour only); the block is
 * decorative, the name says what it is.
 */
function SignalTag({
  code,
  icon,
  color,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { code: string | null; icon?: string | null; color: SignalColor }) {
  const mark = code ?? icon ?? null
  return (
    <span
      data-slot="signal-tag"
      data-color={color}
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-tag border-bw border-border bg-card text-body-sm font-bold whitespace-nowrap text-ink shadow-e1",
        className
      )}
      {...props}
    >
      <b
        aria-hidden
        className={cn(
          "flex min-w-3 items-center border-r-2 border-border px-1.5 font-mono text-data-sm font-bold uppercase",
          signalColorClasses(color).solid
        )}
      >
        {mark}
      </b>
      <span className="bg-card px-2">{children}</span>
    </span>
  )
}

/** Key cap, e.g. <Kbd>J</Kbd>. */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex items-center rounded-[5px] border-[1.5px] border-b-[3px] border-border bg-card px-1.5 font-mono text-data-sm font-semibold text-ink",
        className
      )}
      {...props}
    />
  )
}

/** Count pill. Values above 99 render as "99+" (tokens.md). Pass `highlight` for the gold variant. */
function CountBadge({
  value,
  highlight = false,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { value: number; highlight?: boolean }) {
  return (
    <Badge
      variant={highlight ? "count-hi" : "count"}
      className={cn("tabular-nums", className)}
      {...props}
    >
      {value > 99 ? "99+" : value}
    </Badge>
  )
}

/** Removable filter chip: label + a remove button (the caller provides its accessible name). */
function FilterChip({
  children,
  onRemove,
  removeLabel,
  removeDisabled = false,
  className,
  ...props
}: Omit<React.ComponentProps<"span">, "onChange"> & { onRemove?: () => void; removeLabel: string; /** The remove button is not usable right now (a request is in flight). */ removeDisabled?: boolean }) {
  return (
    <span
      data-slot="filter-chip"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-tag border-bw border-border bg-hi py-0 pr-1 pl-2.5 text-body-sm font-bold text-hi-ink",
        className
      )}
      {...props}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          aria-label={removeLabel}
          onClick={onRemove}
          disabled={removeDisabled}
          className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[4px] font-extrabold hover:bg-[color-mix(in_srgb,var(--ink)_15%,transparent)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          <span aria-hidden>×</span>
        </button>
      ) : null}
    </span>
  )
}

export { Badge, badgeVariants, SignalTag, Kbd, CountBadge, FilterChip }
