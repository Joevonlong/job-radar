import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BackLink } from "@/components/jobs/detail/back-link";
import { Workbench } from "@/components/writer/workbench";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { getDb } from "@/lib/db";
import { loadWorkbench } from "@/lib/writer/view";

type Params = Promise<{ id: string }>;

function parseJobId(raw: string): number | null {
  return /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const id = parseJobId((await params).id);
  if (id === null) return {};
  const [view, t] = await Promise.all([loadWorkbench(getDb(), id), getTranslations("writer")]);
  return view ? { title: t("pageTitle", { title: view.job.title, company: view.job.company }) } : {};
}

/** The application writer's workbench for one job: material on the left, questions in the middle, the answer on the right. */
export default async function ApplyPage({ params }: { params: Params }) {
  const id = parseJobId((await params).id);
  if (id === null) notFound();
  const view = await loadWorkbench(getDb(), id);
  if (!view) notFound();
  const t = await getTranslations("writer");
  return (
    <div data-wide className="mx-auto flex w-full max-w-[90rem] min-w-0 flex-col gap-4" data-testid="writer-page" data-job-id={view.job.id}>
      <div className="flex min-w-0 flex-col gap-1.5">
        <BackLink href={`/jobs/${view.job.id}`} label={t("back")} />
        <h1 className="font-display text-h1 [overflow-wrap:anywhere]">{t("heading")}</h1>
        <p className="text-ink-2 text-body-sm [overflow-wrap:anywhere]">
          {view.job.title} · {view.job.company}
        </p>
      </div>
      <Workbench view={view} timeZone={getDisplayTimeZone()} />
    </div>
  );
}
