"use client";

import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useTranslations } from "next-intl";

import type { TextIssue } from "@/lib/settings/advanced/types";

interface IssueListProps {
  issues: readonly TextIssue[];
  warnings: readonly TextIssue[];
  /** A validation is running or has not answered yet. */
  checking: boolean;
  onJump: (line: number, col: number) => void;
  /** The issue's own explanation, in the page language (the schema's messages are English). */
  describe: (issue: TextIssue) => string;
}

/** The problems of the text: one row each with path, reason and line:col; a click puts the cursor there. */
export function IssueList({ issues, warnings, checking, onJump, describe }: IssueListProps) {
  const t = useTranslations("settings.advanced");
  if (issues.length === 0 && warnings.length === 0) {
    return (
      <p className="text-term-green flex items-center gap-1.5 font-mono text-data" role="status" data-testid="issues-ok" data-checking={checking ? "true" : "false"}>
        <CheckCircle2 aria-hidden className="size-4" /> {checking ? t("checking") : t("noIssues")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="issue-list" data-checking={checking ? "true" : "false"}>
      {issues.length > 0 ? (
        <p role="status" className="text-bad flex items-center gap-1.5 font-mono text-data font-bold">
          <AlertTriangle aria-hidden className="size-4" /> {t("issueCount", { count: issues.length })}
        </p>
      ) : null}
      <ul className="border-border max-h-48 overflow-auto rounded-card border-bw">
        {[...issues.map((issue) => ({ issue, level: "error" as const })), ...warnings.map((issue) => ({ issue, level: "warning" as const }))].map(({ issue, level }, index) => (
          <li key={`${level}-${issue.path}-${issue.line}-${index}`} className="border-border border-b-bw last:border-b-0">
            <button
              type="button"
              data-testid="issue-row"
              data-level={level}
              disabled={issue.file !== undefined}
              onClick={() => onJump(issue.line, issue.col)}
              className="hover:bg-hi/40 flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5 text-left disabled:cursor-default disabled:hover:bg-transparent"
            >
              {level === "warning" ? <Info aria-hidden className="text-ink-3 size-3.5 shrink-0 self-center" /> : null}
              <span className="font-mono text-data font-bold [overflow-wrap:anywhere]">{issue.path === "" ? t("wholeFile") : issue.path}</span>
              <span className="text-ink-2 text-body-sm min-w-0 [overflow-wrap:anywhere]">{describe(issue)}</span>
              <span className="text-ink-3 text-data-sm ml-auto font-mono whitespace-nowrap">
                {issue.file !== undefined ? t("otherFile", { file: issue.file }) : `${issue.line}:${issue.col}${issue.exact ? "" : ` (${t("nearest")})`}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
