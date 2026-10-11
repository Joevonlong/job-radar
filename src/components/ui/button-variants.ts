import { cva } from "class-variance-authority"

/*
 * Button (design system v3, tokens.md "按钮"): 2px ink border, hard shadow, press = move by --press-d while the
 * shadow collapses. Variants primary / ink / default / ghost / danger / link; sizes sm / md / lg / icon.
 * Legacy names stay valid for existing callers: outline -> default, secondary -> default, destructive -> danger,
 * size "default" -> md, "xs" / "icon-xs" are compact legacy sizes, "icon-sm" / "icon-lg" are the icon sizes.
 */
export const buttonVariants = cva(
  [
    "press relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 border-bw font-extrabold whitespace-nowrap select-none",
    // loading (aria-busy) buttons are disabled but keep full opacity: they show a spinner instead of looking switched off
    "disabled:pointer-events-none disabled:shadow-none aria-disabled:pointer-events-none aria-disabled:shadow-none [&:is(:disabled,[aria-disabled=true]):not([aria-busy=true])]:opacity-45",
    "aria-invalid:border-bad",
    "aria-pressed:bg-hi aria-pressed:text-hi-ink aria-pressed:shadow-none aria-pressed:[translate:var(--press-d)_var(--press-d)]",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary:
          "border-border bg-hi text-hi-ink lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-[color-mix(in_srgb,var(--hi)_85%,var(--ink))]",
        ink: "border-border bg-ink text-paper lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-[color-mix(in_srgb,var(--ink)_85%,var(--bg))]",
        default: "border-border bg-card text-ink lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-soft",
        ghost:
          "border-transparent bg-transparent text-ink shadow-none hover:border-border hover:bg-soft",
        danger:
          "border-border bg-bad text-on-bad lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-[color-mix(in_srgb,var(--bad)_85%,var(--ink))]",
        link: "h-auto min-h-0 border-0 bg-transparent px-0.5 font-mono font-bold text-ink underline decoration-2 underline-offset-4 shadow-none hover:bg-hi hover:text-hi-ink",
        // legacy names
        outline: "border-border bg-card text-ink lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-soft",
        secondary: "border-border bg-card text-ink lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-soft",
        destructive:
          "border-border bg-bad text-on-bad lift [--lift-shadow:var(--e3)] shadow-e2 hover:bg-[color-mix(in_srgb,var(--bad)_85%,var(--ink))]",
      },
      size: {
        sm: "h-ctl-sm rounded-tag px-3 text-label has-[>svg]:px-2.5",
        md: "h-ctl-md rounded-btn px-4 text-label has-[>svg]:px-3",
        lg: "h-ctl-lg rounded-btn px-5 text-body shadow-e3 [--lift-shadow:var(--e4)] has-[>svg]:px-4",
        icon: "size-ctl-md rounded-btn p-0",
        "icon-sm": "size-ctl-sm rounded-tag p-0",
        "icon-lg": "size-ctl-lg rounded-btn p-0",
        // legacy names
        default: "h-ctl-md rounded-btn px-4 text-label has-[>svg]:px-3",
        xs: "h-sp-6 gap-1 rounded-cell px-2 text-data shadow-e1 [--lift-shadow:var(--e2)] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        "icon-xs": "size-sp-6 rounded-cell p-0 shadow-e1 [--lift-shadow:var(--e2)] [&_svg:not([class*='size-'])]:size-3",
      },
    },
    compoundVariants: [
      // link keeps its own box: no fixed height, no min width
      { variant: "link", size: ["sm", "md", "lg", "default", "xs"], class: "h-auto px-0.5" },
      { variant: "ghost", class: "shadow-none" },
      { variant: "link", class: "shadow-none" },
    ],
    defaultVariants: {
      variant: "default",
      size: "md",
    },
  }
)
