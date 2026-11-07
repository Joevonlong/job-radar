import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { PageHeader } from "@/components/shell/page-header";
import { TailorWorkspace, type TailorView } from "@/components/career/tailor-workspace";
import { tailorStatusSchema } from "@/components/career/tailor-api";
import { readCareerGate } from "@/lib/config/career-gate";
import { reloadConfig } from "@/lib/config/load";
import { documentIdSchema } from "@/lib/career/schema/document";
import { loadDocument } from "@/lib/career/store/documents";
import { loadPreferences } from "@/lib/career/store/preferences";
import { readProposals } from "@/lib/career/tailor/proposals";
import { readCareerTailorStatus } from "@/lib/career/tailor/request";
import { getDb } from "@/lib/db";
import { getJobForBreakdown } from "@/lib/db/repos/breakdowns";
import { logActionFailure } from "@/lib/logging/action-failure";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({
  job: z.coerce.number().int().positive().optional().catch(undefined),
  doc: documentIdSchema.optional().catch(undefined),
  mode: z.enum(["tailor", "shrink"]).optional().catch(undefined),
  over: z.coerce.number().int().positive().max(100).optional().catch(undefined),
});

async function settled<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  try { return await run(); }
  catch (error) { logActionFailure(name, error); return null; }
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const params = paramsSchema.parse(await searchParams);
  const settings = reloadConfig("career");
  const preferences = await settled("careerTailorPreferences", loadPreferences);
  const loaded = params.doc ? await settled("careerTailorDocument", () => loadDocument(params.doc!)) : null;
  if (params.doc && !loaded) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert">{t("documents.loadError")}</p>
        <Link href="/career/tailor" className="underline">
          {t("tailor.startOver")}
        </Link>
      </div>
    );
  }
  const doc = loaded?.document ?? null;
  const shrink = params.mode === "shrink" && doc !== null && params.over !== undefined;
  const job = doc
    ? doc.job && { id: doc.job.id, title: doc.job.title, company: doc.job.company, description: "present" }
    : params.job ? await settled("careerTailorJob", () => getJobForBreakdown(getDb(), params.job!)) : null;
  const status = doc ? await settled("careerTailorStatus", () => readCareerTailorStatus(getDb(), doc.id)) : null;
  const proposals = doc ? await settled("careerTailorProposals", () => readProposals(doc.id)) : null;
  const view: TailorView = {
    limits: { maxRequirements: settings.tailor.max_requirements, requirementMaxChars: settings.tailor.requirement_max_chars },
    preferences: preferences ? { emphasis: preferences.preferences.emphasis, tone: preferences.preferences.tone } : null,
    job: job ? { id: job.id, title: job.title, company: job.company } : null,
    jobState: params.job && !doc && !job ? "job_gone" : job && !doc && !job.description?.trim() ? "no_jd" : null,
    doc: doc && { id: doc.id, title: doc.title, jobId: doc.job?.id ?? null, requirements: doc.requirements },
    mode: shrink ? "shrink" : "tailor",
    overPages: shrink ? params.over ?? null : null,
    status: status ? tailorStatusSchema.safeParse(status).data ?? null : null,
    hasProposals: Boolean(proposals?.items.length),
  };
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title={t("tailor.title")} description={t("tailor.description")} />
      <TailorWorkspace key={doc?.id ?? `job-${view.job?.id ?? "none"}`} view={view} />
    </div>
  );
}
