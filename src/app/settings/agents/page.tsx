import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { AgentAccessPage } from "@/components/agents/agent-access-page";
import { AgentsSubnav } from "@/components/agents/subnav";
import { PageHeader } from "@/components/shell/page-header";
import { loadAgentAccessView, mcpAddress } from "@/lib/agent-access/settings-view";
import { requestOwnerSession } from "@/lib/security/owner-session";

// Reads mcp.yaml, the session and the database on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("agents.page");
  return { title: t("title") };
}

export default async function Page() {
  const t = await getTranslations("agents.page");
  const now = new Date();
  const view = await loadAgentAccessView(await requestOwnerSession(), now);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      <AgentsSubnav current="access" />
      <AgentAccessPage view={view} address={mcpAddress(await headers())} now={now.toISOString()} />
    </div>
  );
}
