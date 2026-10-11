"use client";

import { History, RotateCcw } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DiffLine, HistoryEntry, ProfileName } from "@/lib/profile/types";

interface HistoryPanelProps {
  sections: { kind: ProfileName; title: string; history: HistoryEntry[] }[];
  dbAvailable: boolean;
  pending: boolean;
  /** The file that was saved last: the list switches to it whenever `nonce` changes. */
  follow: { kind: ProfileName; nonce: number } | null;
  onRollback: (kind: ProfileName, snapshotId: number) => void;
}

export function HistoryPanel({ sections, dbAvailable, pending, follow, onRollback }: HistoryPanelProps) {
  const t = useTranslations("profile.history");
  const headingId = useId();
  const [kind, setKind] = useState<ProfileName>(follow?.kind ?? sections[0]?.kind ?? "me");
  const [followed, setFollowed] = useState(follow?.nonce ?? 0);
  if (follow && follow.nonce !== followed) {
    // Adjusting state while rendering (instead of in an effect) avoids a stale first paint.
    setFollowed(follow.nonce);
    setKind(follow.kind);
  }
  const active = sections.find((section) => section.kind === kind) ?? sections[0];

  return (
    <Card className="gap-4 py-4" data-testid="history-card">
      <CardHeader className="px-4">
        <CardTitle>
          <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
            <History aria-hidden className="size-4" />
            {t("title")}
          </h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        {!dbAvailable ? (
          <p role="status" className="text-warning-text text-sm">
            {t("dbUnavailable")}
          </p>
        ) : null}
        <div role="group" aria-labelledby={headingId} className="bg-muted inline-flex w-fit rounded-lg p-[3px]">
          {sections.map((section) => (
            <button
              key={section.kind}
              type="button"
              aria-pressed={section.kind === kind}
              onClick={() => setKind(section.kind)}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                section.kind === kind ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {section.title}
            </button>
          ))}
        </div>
        {active && active.history.length === 0 ? <p className="text-muted-foreground text-sm">{t("empty")}</p> : null}
        <ol className="flex flex-col gap-2" aria-label={active?.title}>
          {active?.history.map((entry) => (
            <HistoryItem key={entry.id} kind={active.kind} entry={entry} pending={pending} onRollback={onRollback} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function HistoryItem({
  kind,
  entry,
  pending,
  onRollback,
}: {
  kind: ProfileName;
  entry: HistoryEntry;
  pending: boolean;
  onRollback: (kind: ProfileName, snapshotId: number) => void;
}) {
  const t = useTranslations("profile.history");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [rolling, startTransition] = useTransition();
  const diffId = useId();

  return (
    <li className="border-border rounded-md border" data-testid="history-item" data-current={entry.current || undefined}>
      <div className="flex flex-col gap-1.5 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <time dateTime={entry.savedAt} className="font-mono text-xs tabular-nums">
            {format.dateTime(new Date(entry.savedAt), { dateStyle: "medium", timeStyle: "medium" })}
          </time>
          {entry.current ? (
            <Badge variant="outline" className="text-success border-success/40">
              {t("current")}
            </Badge>
          ) : null}
        </div>
        <div className="-ml-2 flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={open}
            aria-controls={diffId}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? t("hideChanges") : t("showChanges")}
          </Button>
          {!entry.current ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={pending || rolling}
              onClick={() => startTransition(() => onRollback(kind, entry.id))}
            >
              <RotateCcw aria-hidden />
              {rolling ? t("rollingBack") : t("rollback")}
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <div id={diffId} className="border-border border-t">
          {entry.diff === null ? (
            <p className="text-muted-foreground px-3 py-2 text-xs">{t("initial")}</p>
          ) : (
            <DiffView lines={entry.diff} />
          )}
        </div>
      ) : null}
    </li>
  );
}

const DIFF_STYLE: Record<DiffLine["type"], string> = {
  add: "bg-success/15 text-success",
  del: "bg-destructive/15 text-destructive",
  context: "text-muted-foreground",
  gap: "text-muted-foreground",
};
const DIFF_MARK: Record<DiffLine["type"], string> = { add: "+", del: "-", context: " ", gap: "…" };

function DiffView({ lines }: { lines: DiffLine[] }) {
  const t = useTranslations("profile.history");
  return (
    <pre className="max-h-64 overflow-auto py-1 font-mono text-xs leading-5" tabIndex={0}>
      {lines.map((line, index) => (
        <div key={index} className={cn("flex gap-2 px-3", DIFF_STYLE[line.type])} data-diff={line.type}>
          <span aria-hidden className="w-3 shrink-0 select-none">
            {DIFF_MARK[line.type]}
          </span>
          {line.type === "add" ? <span className="sr-only">{t("diffAdded")}</span> : null}
          {line.type === "del" ? <span className="sr-only">{t("diffRemoved")}</span> : null}
          <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}
