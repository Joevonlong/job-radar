import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import { PageHeader } from "@/components/shell/page-header";
import { MarketScopeProvider } from "@/components/settings/market-scope";
import { SettingsEditor } from "@/components/settings/settings-editor";
import { SignOutEverywhere } from "@/components/settings/sign-out-everywhere";
import { getSchedule } from "@/lib/dashboard/context";
import { isTranslatedRegion, loadMarketView } from "@/lib/market/view";
import { readWebAccess } from "@/lib/security/web-access";
import { loadSettingsPage } from "@/lib/settings/view";

// Reads the config files and the database on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.settings");
  return { title: t("title") };
}

export default async function Page() {
  const t = await getTranslations("pages.settings");
  const data = await loadSettingsPage();
  const tRegions = await getTranslations("market.regions");
  const market = loadMarketView(await getLocale(), (id) => (isTranslatedRegion(id) ? tRegions(id) : null));
  let timezone = "UTC";
  try {
    timezone = getSchedule().timezone;
  } catch {
    // an invalid schedule.yaml is reported by its tab; times fall back to UTC
  }
  // the optional web password: "sign out everywhere" only means something when there is one
  const passwordSet = readWebAccess(await headers(), await cookies()).password !== null;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <MarketScopeProvider value={{ options: market.scopeOptions, countryName: market.countryName }}>
        <SettingsEditor sections={data.sections} status={data.status} channelChoices={data.channelChoices} providerStates={data.providerStates} catalog={data.catalog} catalogError={data.catalogError} workflow={data.workflow} criteriaImpact={data.criteriaImpact} aiDisclosure={data.aiDisclosure} telegram={data.telegram} timezone={timezone} now={new Date().toISOString()} />
      </MarketScopeProvider>
      {passwordSet ? <SignOutEverywhere /> : null}
    </div>
  );
}
