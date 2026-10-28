import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { AutoRefresh } from "@/components/sources/auto-refresh";
import { Banner } from "@/components/sources/banner";
import { CandidatesCard } from "@/components/sources/candidates-card";
import { ExportMenu } from "@/components/sources/registry/export-menu";
import { ImportDialog } from "@/components/sources/registry/import-dialog";
import { RegistryExplorer, type ReadOnlyReason } from "@/components/sources/registry/registry-explorer";
import { SourcesSubnav } from "@/components/sources/subnav";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { loadBoardCandidates } from "@/lib/sources/candidates";
import { loadRegistryPage, type RegistryPageData } from "@/lib/sources/registry/load";

// Reads sources.yaml, the database and the health data on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.sourcesRegistry");
  return { title: t("title") };
}

export default async function Page() {
  const [t, tr, format] = await Promise.all([getTranslations("pages.sourcesRegistry"), getTranslations("sourcesRegistry"), getFormatter()]);
  const timeZone = getDisplayTimeZone();
  let data: RegistryPageData | null = null;
  try {
    data = await loadRegistryPage();
  } catch {
    data = null;
  }
  const candidates = data === null ? null : await loadBoardCandidates();

  if (data === null) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t("title")} description={t("description")} />
        <SourcesSubnav current="registry" />
        <Banner tone="bad" testId="registry-unavailable">
          {tr("banner.unavailable")}
        </Banner>
      </div>
    );
  }

  const { view, file, mirror } = data;
  const readOnly: ReadOnlyReason = file.invalid !== null ? "invalid" : null;
  const syncedAt = mirror.syncedAt === null ? null : format.dateTime(new Date(mirror.syncedAt), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const fileLabel = file.label;
  const nowIso = new Date().toISOString();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        description={
          <span data-testid="mirror-line" data-in-sync={mirror.inSync && !view.fromMirror ? "1" : "0"}>
            <span className="[overflow-wrap:anywhere]">{fileLabel}</span> · {tr("header.count", { count: view.total })} ·{" "}
            {view.fromMirror ? (
              tr("header.fromMirror")
            ) : mirror.inSync ? (
              syncedAt ? tr("header.mirrorSynced", { time: syncedAt }) : tr("header.mirrorNever")
            ) : (
              <span className="text-warning-text font-bold" title={tr("header.mirrorStaleHint")} data-testid="mirror-stale">
                {tr("header.mirrorStale")}
              </span>
            )}
          </span>
        }
        actions={
          <>
            <ImportDialog importMaxBytes={data.limits.importMaxBytes} />
            <ExportMenu yamlAvailable={file.mode !== "missing"} jsonAvailable={file.invalid === null} />
          </>
        }
      />
      <SourcesSubnav current="registry" />
      <AutoRefresh active={data.cycleRunning} />

      {file.invalid !== null ? (
        <Banner tone="bad" testId="banner-invalid">
          <p>{tr("banner.invalid")}</p>
          <ul className="mt-1 font-mono text-data">
            {file.invalid.map((issue, index) => (
              <li key={`${issue.path}-${index}`}>
                {issue.path === "" ? tr("banner.wholeFile") : issue.path}: {issue.message}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}

      <RegistryExplorer view={view} nowIso={nowIso} timeZone={timeZone} readOnly={readOnly} alertPercent={data.alertPercent} />
      <CandidatesCard candidates={candidates} timeZone={timeZone} pageSize={data.limits.candidatesPageSize} readOnlyHint={readOnly === null ? null : tr(`readOnly.${readOnly}`)} />
    </div>
  );
}
