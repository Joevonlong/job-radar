"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { INK_LINK } from "@/components/ui/ink-link";
import { COMPANY_RESEARCH_FIELDS, type CompanyResearchView } from "@/lib/research/fields";
import { cn } from "@/lib/utils";

/** Only an https link is ever rendered as a link (the stored sources were checked; this is the second fence). */
function httpsSource(url: string): { href: string; host: string } | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? { href: parsed.href, host: parsed.hostname } : null;
  } catch {
    return null;
  }
}

/** The checked fields of a company background, each with its source; plain text. Shared by the job page and the company list. */
export function CompanyResearchFields({ fields }: { fields: CompanyResearchView["fields"] }) {
  const t = useTranslations("research.company");
  const tField = useTranslations("research.field");
  return (
    <dl className="grid gap-x-4 gap-y-2.5 sm:grid-cols-[9rem_minmax(0,1fr)]" data-testid="company-research-fields">
      {COMPANY_RESEARCH_FIELDS.map((field) => {
        const value = fields[field];
        if (!value) return null;
        const source = httpsSource(value.sourceUrl);
        return (
          <div key={field} className="contents" data-testid={`company-research-field-${field}`}>
            <dt className="text-cap text-ink-3 text-cap-style sm:pt-0.5">{tField(field)}</dt>
            <dd className="min-w-0">
              <span className={cn("max-w-[72ch]", field === "recentNews" && "whitespace-pre-line")}>{value.text}</span>
              {source ? (
                <a href={source.href} target="_blank" rel="noopener noreferrer" className={cn(INK_LINK, "text-data ml-1.5 inline-flex items-center gap-1 font-mono")} aria-label={t("sourceOf", { field: tField(field), host: source.host })} data-testid="company-research-source">
                  {source.host}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
