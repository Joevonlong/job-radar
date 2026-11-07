import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import { listJobDocuments, type JobDocument } from "@/lib/career/store/documents";
import { logActionFailure } from "@/lib/logging/action-failure";
import { descriptionHash } from "@/lib/translation/hash";
import { cn } from "@/lib/utils";

/** The job page's way into tailoring: a link to start and the documents already tailored for this job. Opening it never changes the application status. */
export async function JobEntry({ jobId, description }: { jobId: number; description: string | null }) {
  const t = await getTranslations("career.jobEntry");
  let documents: JobDocument[] | null;
  try {
    documents = await listJobDocuments(jobId, descriptionHash(description));
  } catch (error) {
    logActionFailure("careerJobDocuments", error);
    documents = null;
  }
  return (
    <div className="flex flex-col gap-3" data-testid="career-job-entry">
      <Link href={`/career/tailor?job=${jobId}`} className={cn(buttonVariants({ variant: "outline" }), "self-start")} data-testid="career-job-tailor">
        {t("tailor")}
      </Link>
      {documents === null ? (
        <p role="alert" className="text-muted-foreground text-sm" data-testid="career-job-error">
          {t("error")}
        </p>
      ) : documents.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-sm" data-testid="career-job-documents">
          {documents.map((document) => (
            <li key={document.id} className="flex flex-col">
              <Link href={`/career/documents/${document.id}`} className="underline">
                {document.title}
              </Link>
              {document.jdChanged ? <span className="text-muted-foreground text-xs" data-testid="career-job-jd-changed">{t("jdChanged")}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
