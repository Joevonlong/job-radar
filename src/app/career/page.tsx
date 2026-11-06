import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { CareerEditor } from "@/components/career/career-editor";
import { PageHeader } from "@/components/shell/page-header";
import { readCareerGate } from "@/lib/config/career-gate";
import { reloadConfig } from "@/lib/config/load";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { loadContact } from "@/lib/career/contact/store";
import { listVersions } from "@/lib/career/store/history";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { aiDisclosure } from "@/lib/ai/disclosure";
import { getCareerExtractStatus, listCareerDrafts } from "./actions";
import { cleanupExpiredDrafts } from "@/lib/career/extract/draft-store";
import { logActionFailure } from "@/lib/logging/action-failure";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("career"))("title") };
}

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
  const errors: string[] = [];
  async function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await read();
    } catch (error) {
      logActionFailure("careerPage", error);
      errors.push(error instanceof CareerStoreError ? error.code : "profile_invalid");
      return fallback;
    }
  }
  await safe(cleanupExpiredDrafts, undefined);
  const initial = await safe(async () => loadCareerProfile(), null);
  const contact = await safe(async () => loadContact(), null);
  const versions = await safe(listVersions, []);
  let limits;
  try {
    limits = reloadConfig("career");
  } catch {
    return <p>{t("disabled")}</p>;
  }
  const drafts = initial ? await safe(async () => { const result = await listCareerDrafts({}); if (result.ok) return result.drafts; errors.push(result.code); return []; }, []) : [];
  const status = initial ? await safe(async () => { const result = await getCareerExtractStatus({}); if (!result.ok) { errors.push(result.code); return null; } return result.status.state === "waiting" ? result.status : null; }, null) : null;
  const providers = await safe(async () => aiDisclosure(reloadConfig("ai")).find((row) => row.task === "career_extract")?.providers ?? [], []);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title={t("title")} description={t("description")} />
      <Link href="/career/documents" className="underline">{t("documents.title")}</Link>
      <CareerEditor
        initial={initial}
        contact={contact}
        initialVersions={versions}
        errors={errors}
        limits={limits.profile}
        extraction={{ limits: limits.import, providers, drafts, open: status }}
        timeZone={getDisplayTimeZone()}
      />
    </div>
  );
}
