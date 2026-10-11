import { useTranslations } from "next-intl";

import { Badge, SignalTag } from "@/components/ui/badge";
import type { SignalTier } from "@/lib/db/queries/types";
import { isGermanRequirement, type GermanLevel } from "@/lib/domain/types";
import type { CategoryView } from "@/lib/signals/catalog";

const CONTRACT_BADGES = ["freelance", "student", "fixed_term"] as const;

export interface HeaderTagsProps {
  signals: ReadonlyArray<{ tier: SignalTier; kind: string }>;
  /** The active signal categories, in order; signals of other ids are not shown. */
  categories: readonly CategoryView[];
  salaryDisclosed: boolean;
  germanLevelRequired: GermanLevel;
  isAgency: boolean;
  contract: string;
  /** The market's local language as the page names it; null = no language step (no requirement badge). */
  languageName?: string | null;
}

/**
 * Tags under the title (design `.tags`): one coloured tag per keyword category (category order), the tags of the tag categories
 * with a `+`, and the gates and facts a row of the list also carries: German required, agency, contract kind, "salary not
 * disclosed" (dashed, never read as none). The amount category is no tag here: it is the salary axis next to the title ("T1 不做标签，
 * 它就是薪资轴", docs/design/tokens.md), whose block already says below the floor / another region's pay.
 */
export function HeaderTags({ signals, categories, salaryDisclosed, germanLevelRequired, isAgency, contract, languageName = null }: HeaderTagsProps) {
  const t = useTranslations("dashboard");

  const present = new Set(signals.map((s) => s.tier));
  const paying = categories.filter((category) => category.kind === "keyword" && present.has(category.id));
  const tagKinds = new Map(categories.filter((category) => category.kind === "tag").map((category) => [category.id, category]));
  const benefits = signals.filter((s) => tagKinds.has(s.tier)).filter((s, index, all) => all.findIndex((other) => other.tier === s.tier && other.kind === s.kind) === index);
  const hasAmountSignal = categories.some((category) => category.kind === "amount" && present.has(category.id));
  const contractBadge = CONTRACT_BADGES.find((c) => c === contract);

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="header-tags">
      {paying.map((category) => (
        <SignalTag key={category.id} code={category.code} icon={category.icon} color={category.color} title={category.label} data-testid="header-tag" data-tier={category.id}>
          {category.label}
        </SignalTag>
      ))}
      {benefits.map((tag) => (
        <Badge key={`${tag.tier}-${tag.kind}`} variant="tag" title={tagKinds.get(tag.tier)?.label} data-testid="header-tag" data-tier={tag.tier}>
          <b aria-hidden>+</b> {tag.kind}
        </Badge>
      ))}
      {!hasAmountSignal && !salaryDisclosed ? (
        <Badge variant="gate-note" data-testid="header-tag-salary-unknown">
          — {t("badge.salaryUnknown")}
        </Badge>
      ) : null}
      {languageName !== null && isGermanRequirement(germanLevelRequired) ? (
        <Badge variant="gate-bad" data-testid="header-tag-german">
          <b aria-hidden>!</b> {t("badge.german", { level: germanLevelRequired, language: languageName })}
        </Badge>
      ) : null}
      {isAgency ? <Badge variant="gate-note">{t("badge.agency")}</Badge> : null}
      {contractBadge ? <Badge variant="gate-note">{t(`badge.${contractBadge}`)}</Badge> : null}
    </div>
  );
}
