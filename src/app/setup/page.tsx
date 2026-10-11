import type { Metadata } from "next";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";

import { SetupWizard } from "@/components/setup/setup-wizard";
import { resolveLocale } from "@/i18n/locale";
import { getDb } from "@/lib/db";
import { isTranslatedRegion, loadMarketView } from "@/lib/market/view";
import { loadControlStatus } from "@/lib/settings/status";
import type { ControlStatus } from "@/lib/settings/status-schema";
import { firstOpenStep, SETUP_STEP_IDS } from "@/lib/setup/steps";
import { localeFromAcceptLanguage } from "@/lib/setup/steps/language";
import { loadSetupView } from "@/lib/setup/view";

// Reads the config files, the environment (names only) and the database on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup.meta");
  return { title: t("title") };
}

/** `?step=` is untrusted (C6): an unknown value opens the first step that is not done yet. */
const searchSchema = z.object({ step: z.enum(SETUP_STEP_IDS).optional().catch(undefined) });

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = searchSchema.parse({ step: Array.isArray(raw.step) ? raw.step[0] : raw.step });
  const locale = resolveLocale(await getLocale());
  const view = await loadSetupView({ locale, acceptLanguage: localeFromAcceptLanguage((await headers()).get("accept-language")) });
  const done = Object.fromEntries(Object.entries(view.steps).flatMap(([id, s]) => (s.status === null ? [] : [[id, { status: s.status }]])));
  const step = params.step ?? firstOpenStep(done);

  const tRegions = await getTranslations("market.regions");
  const market = loadMarketView(locale, (id) => (isTranslatedRegion(id) ? tRegions(id) : null));
  let status: ControlStatus | null = null;
  try {
    status = await loadControlStatus(getDb());
  } catch {
    // the database is down: the review step says so
  }
  return <SetupWizard view={view} step={step} market={market} status={status} />;
}
