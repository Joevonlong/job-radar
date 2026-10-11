import { cn } from "@/lib/utils";

/** A small tag saying which language a text is in, for AI text that is not in the UI language. */
export function LanguageTag({ lang, label, title, className }: { lang: string; label: string; title?: string; className?: string }) {
  return (
    <span
      lang={lang}
      title={title}
      data-testid="language-tag"
      data-lang={lang}
      className={cn("border-border text-muted-foreground inline-flex h-5 items-center rounded-sm border px-1.5 text-xs font-normal", className)}
    >
      {label}
    </span>
  );
}
