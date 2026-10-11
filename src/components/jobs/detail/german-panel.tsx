import { useTranslations } from "next-intl";

import { isGermanRequirement, type GermanLevel } from "@/lib/domain/types";

import { FactBadge } from "../signal-badge";

interface GermanPanelProps {
  /** The level used for the deduction (the scoring's settled level). */
  level: GermanLevel;
  rule: GermanLevel;
  ai: GermanLevel | null;
  source: string | null;
  penalty: number;
  /** The user's own German from me.yaml: a CEFR level, "native", or null when none is listed. */
  yours: string | null;
  /** Leave out the first line (required level, your level): the level scale next to it already says so. */
  compact?: boolean;
  /** The market's local language as the page names it ("德语", "German"). */
  languageName: string;
}

const KNOWN_SOURCES = ["agree", "rule", "ai", "rule_explicit", "ai_explicit", "rule_preferred"] as const;

/** Level text for the "rule / AI" lines: CEFR levels as they are, `none`, `preferred` and `unknown` in words. */
function useLevelLabel() {
  const t = useTranslations("scoring.german");
  return (level: GermanLevel) => (level === "none" ? t("level.none") : level === "preferred" ? t("level.preferred") : level === "unknown" ? t("level.unknown") : level);
}

/**
 * "German requirement" block of the job detail page: what level the posting asks for, how it
 * was settled between the pipeline rule and the AI's reading, and the points it cost.
 */
export function GermanPanel({ level, rule, ai, source, penalty, yours, compact = false, languageName }: GermanPanelProps) {
  const t = useTranslations("scoring.german");
  const label = useLevelLabel();
  const required = isGermanRequirement(level);
  const knownSource = KNOWN_SOURCES.find((s) => s === source);

  return (
    <div className="flex flex-col gap-2" data-testid="german-panel">
      <div className={compact ? "sr-only" : "flex flex-wrap items-center gap-2"}>
        {required ? <FactBadge>{t("required", { level, language: languageName })}</FactBadge> : <span className="text-muted-foreground">{level === "none" ? t("none", { language: languageName }) : level === "preferred" ? t("preferred", { language: languageName }) : t("unknown", { language: languageName })}</span>}
        <span className="text-muted-foreground text-[13px]">{t("yours", { level: yours ?? t("yoursNone"), language: languageName })}</span>
      </div>
      <p className={penalty > 0 ? "text-foreground font-medium" : "text-muted-foreground"} data-testid="german-penalty">
        {penalty > 0 ? t("penalty", { points: penalty }) : t("noPenalty")}
      </p>
      <p className="text-muted-foreground text-[13px]">
        {t("rule", { level: label(rule) })}
        {ai !== null ? <> · {t("ai", { level: label(ai) })}</> : null}
      </p>
      {knownSource ? <p className="text-muted-foreground text-xs">{t(`source.${knownSource}`)}</p> : null}
    </div>
  );
}
