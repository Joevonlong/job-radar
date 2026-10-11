"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AdvancedFileEntry } from "@/lib/settings/advanced/types";
import { cn } from "@/lib/utils";

interface FileListProps {
  entries: readonly AdvancedFileEntry[];
  selected: string | null;
  onSelect: (stem: string) => void;
}

/** The left column: every config file in two groups, each with where it is read from, whether it is valid and whether its version is behind. */
export function FileList({ entries, selected, onSelect }: FileListProps) {
  const t = useTranslations("settings.advanced.files");
  const groups = [
    { id: "user", entries: entries.filter((entry) => entry.group === "user") },
    { id: "shipped", entries: entries.filter((entry) => entry.group === "shipped") },
  ] as const;
  return (
    <nav aria-label={t("label")} className="flex min-w-0 flex-col gap-4" data-testid="advanced-files">
      {groups.map((group) =>
        group.entries.length === 0 ? null : (
          <section key={group.id} className="flex flex-col gap-1">
            <h3 className="text-label text-ink-2 px-1 font-bold">{t(`group_${group.id}`)}</h3>
            <ul className="flex flex-col gap-1">
              {group.entries.map((entry) => (
                <li key={entry.stem}>
                  <button
                    type="button"
                    data-testid={`advanced-file-${entry.stem}`}
                    aria-current={entry.stem === selected ? "true" : undefined}
                    onClick={() => onSelect(entry.stem)}
                    className={cn("hover:bg-soft border-border flex w-full min-w-0 flex-col gap-0.5 rounded-tag border-bw border-transparent px-2 py-1.5 text-left", entry.stem === selected && "bg-hi text-hi-ink border-border hover:bg-hi")}
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      {entry.valid ? <CheckCircle2 aria-label={t("valid")} className="text-good size-3.5 shrink-0" /> : <AlertTriangle aria-label={t("invalid")} className="text-bad size-3.5 shrink-0" />}
                      <span className="font-mono text-data font-bold [overflow-wrap:anywhere]">{entry.file}</span>
                    </span>
                    <span className={cn("text-data-sm flex flex-wrap gap-x-2 font-mono", entry.stem === selected ? "text-hi-ink" : "text-ink-3")} data-testid={`advanced-file-source-${entry.stem}`}>
                      <span>{entry.overridden ? t("source_overridden") : entry.layer === "user" ? t("source_user") : entry.layer === "default" ? t("source_default") : t("source_missing")}</span>
                      {entry.versionBehind ? <span className="text-ink-2 font-bold">{t("versionBehind")}</span> : null}
                    </span>
                    {!entry.valid && entry.firstProblem ? <span className="text-bad text-data-sm [overflow-wrap:anywhere]">{entry.firstProblem}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </nav>
  );
}
