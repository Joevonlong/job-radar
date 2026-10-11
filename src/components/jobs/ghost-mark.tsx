import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

import "./ghost-mark.css";

/** A ghost job mark as the list and the score card draw it (only when ui.yaml `job_checks.ghost.enabled`; dismissed marks are absent). */
export interface GhostMarkValue {
  level: "watch" | "likely";
  score: number;
  /** The strongest reasons in their short form, joined ("open 214 days · relisted under a new id"); the server words them. */
  reasons: string;
}

/**
 * Under the score: "Likely ghost" (`--warn` with the hatch and an ink line) or a grey "Watch". The tooltip names the strongest reasons and
 * says it is a guess that leaves the score alone. `href` (the detail page's score card) makes it a link to the checks panel.
 */
export function GhostMark({ ghost, href, className }: { ghost: GhostMarkValue; href?: string; className?: string }) {
  const t = useTranslations("ghostJobs.mark");
  const label = t(ghost.level);
  const title = t("title", { level: label, score: ghost.score, reasons: ghost.reasons });
  const classes = cn(
    "rounded-tag border-bw font-mono text-data-sm inline-block w-fit max-w-full overflow-hidden px-1.5 font-bold text-ellipsis whitespace-nowrap",
    ghost.level === "likely" ? "ghost-likely bg-warn text-on-signal border-ink" : "border-ink-3 text-ink-2 bg-card",
    className,
  );
  const common = { "data-testid": "ghost-mark", "data-level": ghost.level, title, className: classes } as const;
  if (href) {
    return (
      <a href={href} {...common} aria-label={`${title} ${t("jump")}`}>
        {label}
      </a>
    );
  }
  return (
    <span {...common} aria-label={title}>
      {label}
    </span>
  );
}
