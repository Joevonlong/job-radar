import { Building2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { knownFamily } from "@/lib/dashboard/labels";
import { cn } from "@/lib/utils";

/**
 * Two-letter marks per source family (from the mockup); an unknown family shows its first letters. `ats` (a company's
 * own job board) and `linkedin` have a drawn mark: "in" in a small monospace box read as "1n", and "AT" says nothing.
 */
const FAMILY_MARK: Record<string, string> = {
  ats: "AT",
  linkedin: "LI",
  stepstone: "St",
  xing: "X",
  indeed: "Id",
  arbeitsagentur: "BA",
  google: "G",
  email: "@",
  manual: "M",
};

export function familyMark(family: string): string {
  return FAMILY_MARK[family] ?? family.slice(0, 2);
}

/** The LinkedIn logo (a rounded square with "in" cut out), drawn in the colour of the text around it. */
function LinkedInMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-[22px]" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

export function SourceIcon({ family, className }: { family: string; className?: string }) {
  const t = useTranslations("dashboard.source");
  const known = knownFamily(family);
  const name = known ? t(known) : family;
  if (family === "linkedin") {
    return (
      <span data-slot="source-icon" data-family={family} title={name} className={cn("inline-flex size-[22px] flex-none items-center justify-center text-[#0a66c2] dark:text-[#70b5f9]", className)}>
        <LinkedInMark />
        <span className="sr-only">{name}</span>
      </span>
    );
  }
  return (
    <span
      data-slot="source-icon"
      data-family={family}
      title={name}
      className={cn(
        "border-border bg-muted text-muted-foreground inline-flex size-[22px] flex-none items-center justify-center rounded-sm border font-mono text-[10px] leading-none font-medium",
        family === "ats" && "bg-accent text-accent-foreground",
        className,
      )}
    >
      {family === "ats" ? <Building2 aria-hidden className="size-3.5" /> : <span aria-hidden>{familyMark(family)}</span>}
      <span className="sr-only">{name}</span>
    </span>
  );
}

export function SourceIcons({ families }: { families: readonly string[] }) {
  return (
    <span className="inline-flex gap-[3px]" data-slot="source-icons">
      {families.map((family) => (
        <SourceIcon key={family} family={family} />
      ))}
    </span>
  );
}
