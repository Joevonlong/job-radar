import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AgentActivity } from "@/components/agents/activity";
import { AgentsSubnav } from "@/components/agents/subnav";
import { PageHeader } from "@/components/shell/page-header";
import { Banner } from "@/components/sources/banner";
import { loadAgentActivity, type AgentActivitySearchParams } from "@/lib/agent-access/activity";

// Reads the audit table on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents.activity");
  return { title: t("title") };
}

export default async function Page({ searchParams }: { searchParams: Promise<AgentActivitySearchParams> }) {
  const t = await getTranslations("agents.activity");
  const now = new Date();
  const data = await loadAgentActivity(await searchParams, now).catch(() => null);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      <AgentsSubnav current="activity" />
      {data === null ? (
        <Banner tone="bad" testId="agents-activity-error">
          {t("error")}
        </Banner>
      ) : (
        <AgentActivity data={data} now={now.toISOString()} />
      )}
    </div>
  );
}
