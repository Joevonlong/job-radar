"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { JOB_SCOPES } from "@/lib/jobs/constants";
import { resolveJobScope } from "@/lib/jobs/scope";
import { jobsListHref, type JobsSearchParams } from "@/lib/jobs/search-params";
import { cn } from "@/lib/utils";

/** Links always pin scope: later status changes and clear-filters must not invoke the legacy absent-scope rule. */
export function ScopeSwitch({ params, archiveCount }: { params: JobsSearchParams; archiveCount: number | null }) {
  const t = useTranslations("dashboard.jobs.scope");
  const active = resolveJobScope(params.scope, params.status);
  return (
    <div
      role="group"
      aria-label={t("label")}
      data-testid="scope-switch"
      className="grid w-full max-w-full grid-cols-3 rounded-btn border-bw border-border bg-card shadow-e2 sm:w-fit"
    >
      {JOB_SCOPES.map((scope) => (
        <Link
          key={scope}
          aria-current={active === scope ? "true" : undefined}
          data-testid={`scope-${scope}`}
          title={scope === "archive" ? t("archiveHint") : undefined}
          href={jobsListHref({
            ...params, scope, page: null,
            ...(scope !== "archive" ? { reason: null } : {}),
            ...(scope === "current" && params.sort === "last_listed" ? { sort: null, dir: null } : {}),
          })}
          className={cn(
            "flex min-w-0 items-center justify-center border-l-bw border-border px-3 py-1.5 text-center text-label font-bold first:rounded-l-btn first:border-l-0 last:rounded-r-btn focus-visible:outline focus-visible:outline-bw focus-visible:outline-ring",
            active === scope ? "bg-ink text-paper" : "text-ink hover:bg-soft",
          )}
        >
          {scope === "archive" ? (archiveCount === null ? t("archiveUnknown") : t("archive", { count: archiveCount })) : t(scope)}
        </Link>
      ))}
    </div>
  );
}
