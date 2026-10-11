import { cva } from "class-variance-authority"

/*
 * Shared look of text inputs, textareas and selects (design system v3, tokens.md "输入"):
 * 2px ink border, hover soft fill, focus = hard shadow (the global 3px t4 outline stays), invalid = red border + red
 * shadow, disabled = dashed + soft fill, read-only = dotted + transparent.
 */
export const fieldBase = [
  "w-full min-w-0 border-bw border-border bg-card text-ink font-medium",
  "placeholder:font-normal placeholder:text-ink-3",
  "transition-[box-shadow,background-color] duration-fast",
  "hover:bg-soft focus-visible:shadow-e2",
  "aria-invalid:border-bad aria-invalid:shadow-e2-bad",
  "disabled:cursor-not-allowed disabled:border-dashed disabled:bg-soft disabled:text-ink-3 disabled:hover:bg-soft",
  // [readonly] rather than :read-only, which also matches every <select>
  "[&[readonly]]:border-dotted [&[readonly]]:bg-transparent [&[readonly]]:hover:bg-transparent",
].join(" ")

export const fieldSize = cva("", {
  variants: {
    size: {
      sm: "h-ctl-sm rounded-tag px-2.5 text-body-sm",
      md: "h-ctl-md rounded-btn px-3 text-body",
      lg: "h-ctl-lg rounded-btn px-3.5 text-h2",
    },
  },
  defaultVariants: { size: "md" },
})

export type FieldSize = "sm" | "md" | "lg"
