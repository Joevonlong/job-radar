import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { pdfDisplayName } from "@/lib/resume/types";
import { cn } from "@/lib/utils";

/**
 * "简历：xxx.pdf" for the tailored PDF attached to an application (`applications.resume_variant_path`).
 * Used on the job detail page and by the pipeline cards: pass the stored path, it shows the file name.
 */
export function ResumeChip({ path, className }: { path: string; className?: string }) {
  const t = useTranslations("resume");
  const name = pdfDisplayName(path);
  return (
    <Badge variant="skill" data-slot="resume-chip" title={path} className={cn("max-w-full", className)}>
      <FileText aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{t("chip", { name })}</span>
    </Badge>
  );
}
