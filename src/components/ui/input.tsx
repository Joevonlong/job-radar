import * as React from "react"
import { cn } from "@/lib/utils"
import { fieldBase, fieldSize, type FieldSize } from "@/components/ui/field-styles"

type InputProps = Omit<React.ComponentProps<"input">, "size" | "prefix"> & {
  size?: FieldSize
  /** Content inside the box before the text, e.g. a currency sign. */
  prefix?: React.ReactNode
  /** Content inside the box after the text, e.g. a unit such as "/年". */
  suffix?: React.ReactNode
}

function Input({ className, type, size = "md", prefix, suffix, ...props }: InputProps) {
  const field = (extra?: string) => (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        fieldBase,
        fieldSize({ size }),
        "selection:bg-hi selection:text-hi-ink file:mr-3 file:inline-flex file:border-0 file:bg-transparent file:text-body-sm file:font-bold file:text-ink",
        extra,
        className
      )}
      {...props}
    />
  )

  if (prefix == null && suffix == null) return field()

  // With adornments the border and shadow move to the wrapper; the bare input keeps the global focus outline off.
  const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true"
  return (
    <div
      data-slot="input-group"
      data-size={size}
      data-invalid={invalid ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      className={cn(
        fieldBase,
        fieldSize({ size }),
        "flex items-center gap-2 px-0 focus-within:shadow-e2 has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal-t4",
        invalid && "border-bad shadow-e2-bad",
        props.disabled && "cursor-not-allowed border-dashed bg-soft text-ink-3",
        props.readOnly && "border-dotted bg-transparent",
        className
      )}
    >
      {prefix != null ? (
        <span data-slot="input-prefix" className="pl-3 font-mono text-data font-semibold text-ink-3">
          {prefix}
        </span>
      ) : null}
      <input
        type={type}
        data-slot="input"
        data-size={size}
        className={cn(
          "h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-inherit outline-none placeholder:font-normal placeholder:text-ink-3 focus-visible:outline-none disabled:cursor-not-allowed",
          prefix == null && "pl-3",
          suffix == null && "pr-3"
        )}
        {...props}
      />
      {suffix != null ? (
        <span data-slot="input-suffix" className="pr-3 font-mono text-data font-semibold text-ink-3">
          {suffix}
        </span>
      ) : null}
    </div>
  )
}

export { Input }
export type { InputProps }
