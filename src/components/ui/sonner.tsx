"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

import { setToastUndoLabel, TOAST_LIFE_MS } from "@/lib/toast"
import { cn } from "@/lib/utils"

/** A terminal glyph in the tone's colour, with the tone name for screen readers (colour is never the only cue). */
function Glyph({ glyph, label, className }: { glyph: string; label: string; className: string }) {
  return (
    <span data-icon="" className={cn("grid size-4 shrink-0 place-items-center font-mono text-body leading-none font-bold", className)}>
      <span aria-hidden>{glyph}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * Terminal-coloured toasts in both themes: dark panel, 2px ink border, hard shadow, a glyph per tone
 * (✓ success, i info, ! warn, ✕ error), an amber countdown bar (globals.css) and an optional green "Undo".
 * Fire them with `toast` from "sonner", `toastTone()` or `toastUndo()` from "@/lib/toast".
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const t = useTranslations("shell.toast")
  const undo = t("undo")
  useEffect(() => setToastUndoLabel(undo), [undo])

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // 3.2 s life (tokens.md); the amber drain bar in globals.css reads --toast-life
      duration={TOAST_LIFE_MS}
      toastOptions={{
        classNames: {
          toast: "z-toast font-mono text-data shadow-e3!",
          actionButton: "bg-transparent! font-bold text-term-green! hover:underline",
        },
      }}
      // above a bottom bar when the page has one (globals.css sets --toast-bottom); sonner's own offsets otherwise
      offset={{ bottom: "var(--toast-bottom, 24px)", top: 24, left: 24, right: 24 }}
      mobileOffset={{ bottom: "var(--toast-bottom, 16px)", top: 16, left: 16, right: 16 }}
      icons={{
        success: <Glyph glyph="✓" label={t("success")} className="text-term-green" />,
        info: <Glyph glyph="i" label={t("info")} className="text-term-amber" />,
        warning: <Glyph glyph="!" label={t("warning")} className="text-warn" />,
        error: <Glyph glyph="✕" label={t("error")} className="text-bad" />,
        loading: <span aria-hidden className="spin-ring size-3.5 text-term-amber" />,
      }}
      style={
        {
          // terminal-coloured toast in both themes: dark panel, ink border, hard offset shadow (shadow-e3)
          "--normal-bg": "var(--term-bg)",
          "--normal-text": "var(--term-ink)",
          "--normal-border": "var(--ink)",
          "--border-radius": "var(--r-btn)",
          "--toast-life": `${TOAST_LIFE_MS}ms`,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
