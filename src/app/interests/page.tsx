import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { InterestsEditor } from "@/components/interests/interests-editor";
import { SuggestionsSection } from "@/components/interests/suggestions-section";
import { PageHeader } from "@/components/shell/page-header";
import { loadInterestsPage } from "@/lib/interests/view";

// Reads interests.yaml and the database on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pages.interests");
  return { title: t("title") };
}

export default async function Page() {
  const t = await getTranslations("pages.interests");
  const data = await loadInterestsPage();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <SuggestionsSection />
      <InterestsEditor data={data} />
    </div>
  );
}
