"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { staleCompanies } from "@/lib/writer/similar";

/**
 * A warning when a text that was started from the answer written for another company still names that company. Shown
 * under the version and in the editor; it only reads the text, it never changes it.
 */
export function OldCompanyNotice({ text, from, currentCompany }: { text: string; from: readonly { company: string }[]; currentCompany: string }) {
  const t = useTranslations("writer.reuse");
  const names = staleCompanies(text, from, currentCompany);
  if (names.length === 0) return null;
  return (
    <p role="status" className="text-warning-text text-body-sm flex items-start gap-1.5 [overflow-wrap:anywhere]" data-testid="writer-old-company">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{t("oldCompany", { companies: names.join(", ") })}</span>
    </p>
  );
}
