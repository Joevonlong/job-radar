import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/shell/page-header";
import { DocumentListPage } from "@/components/career/document-list";
import { readCareerGate } from "@/lib/config/career-gate";
import { listDocuments } from "@/lib/career/store/documents";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { primaryText, profileEntryCount } from "@/lib/career/schema/profile";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { logActionFailure } from "@/lib/logging/action-failure";

export const dynamic = "force-dynamic";

export default async function Page() {
  const gate = await readCareerGate();
  const t = await getTranslations("career");
  if (!gate.enabled) {
    return (
      <div data-testid="career-disabled" className="flex flex-col gap-3">
        <p>{t("disabled")}</p>
        <Link href="/settings?tab=workflow" className="underline">
          {t("settings")}
        </Link>
      </div>
    );
  }
  const [documents, loadedProfile] = await Promise.allSettled([listDocuments(), loadCareerProfile()]);
  if (documents.status === "rejected") logActionFailure("careerDocumentsPage", documents.reason);
  if (loadedProfile.status === "rejected") logActionFailure("careerDocumentsProfile", loadedProfile.reason);
  if (documents.status === "rejected") {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert">{t("documents.status.generic")}</p>
        <Link href="/career" className="underline">
          {t("documents.profileLink")}
        </Link>
      </div>
    );
  }
  const profile = loadedProfile.status === "fulfilled" ? loadedProfile.value.profile : null;
  const empty =
    profile === null ||
    (!profileEntryCount(profile) && !primaryText(profile.headline).trim() && !primaryText(profile.summary).trim());
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={t("documents.title")}
        description={t("documents.description")}
        actions={
          <Link href="/career/tailor" className="underline">
            {t("documents.tailorLink")}
          </Link>
        }
      />
      <DocumentListPage
        documents={documents.value}
        profileEmpty={empty}
        profileUnreadable={profile === null}
        timeZone={getDisplayTimeZone()}
      />
    </div>
  );
}
