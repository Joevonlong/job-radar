import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

/** One line on the overview in place of the candidate list: N new boards wait on the registry page. Nothing when there are none. */
export async function CandidatesNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  const t = await getTranslations("sourcesRegistry.candidatesNotice");
  return (
    <p className="border-border rounded-card border-bw bg-card px-4 py-3 text-body-sm font-semibold shadow-e1" data-testid="candidates-notice">
      <Link href="/sources/registry#discovered" className="inline-flex flex-wrap items-center gap-x-2 underline-offset-4 hover:underline">
        {t("text", { count })}
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </p>
  );
}
