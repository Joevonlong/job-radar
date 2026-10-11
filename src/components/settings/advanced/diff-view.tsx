"use client";

import { useTranslations } from "next-intl";

import type { DiffLine } from "@/lib/settings/advanced/types";
import { cn } from "@/lib/utils";

const STYLE: Record<DiffLine["type"], string> = {
  add: "bg-good/20 text-ink",
  del: "bg-bad/15 text-ink",
  context: "text-ink-2",
  gap: "text-ink-3",
};
const MARK: Record<DiffLine["type"], string> = { add: "+", del: "-", context: " ", gap: "…" };

/** A line diff (the same rendering the profile history uses): added lines green, removed ones red, a gap where lines were skipped. */
export function DiffView({ lines, className }: { lines: readonly DiffLine[]; className?: string }) {
  const t = useTranslations("settings.advanced.diff");
  return (
    <pre className={cn("border-border max-h-72 overflow-auto rounded-card border-bw py-1 font-mono text-data leading-5", className)} tabIndex={0} data-testid="diff-view">
      {lines.map((line, index) => (
        <div key={index} className={cn("flex gap-2 px-3", STYLE[line.type])} data-diff={line.type}>
          <span aria-hidden className="w-3 shrink-0 select-none">
            {MARK[line.type]}
          </span>
          {line.type === "add" ? <span className="sr-only">{t("added")}</span> : null}
          {line.type === "del" ? <span className="sr-only">{t("removed")}</span> : null}
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

/** "Changed keys: a.b, c" above a diff. */
export function ChangedPaths({ paths }: { paths: readonly string[] | null }) {
  const t = useTranslations("settings.advanced.diff");
  if (paths === null) return null;
  return (
    <p className="text-body-sm" data-testid="changed-paths">
      <span className="font-bold">{t("changedKeys", { count: paths.length })}</span>{" "}
      <span className="text-ink-2 font-mono text-data [overflow-wrap:anywhere]">{paths.slice(0, 30).join(", ")}{paths.length > 30 ? " …" : ""}</span>
    </p>
  );
}
