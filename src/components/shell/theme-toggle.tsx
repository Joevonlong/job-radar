"use client";

import { FileText, Terminal } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/** Light "paper" / dark "terminal" (design system v3). The label shows the current theme. */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const t = useTranslations("shell");

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      {/* Icon and label switch by CSS so the server render matches regardless of the stored theme. */}
      <FileText className="dark:hidden" aria-hidden />
      <Terminal className="hidden dark:block" aria-hidden />
      {/* The name is built from the content, so it starts with the visible word (a voice-control user can say it): "Paper · Toggle theme". */}
      <span className="max-sm:sr-only">
        <span className="dark:hidden">{t("themePaper")}</span>
        <span className="hidden dark:inline">{t("themeTerminal")}</span>
      </span>
      <span className="sr-only"> · {t("toggleTheme")}</span>
    </Button>
  );
}
