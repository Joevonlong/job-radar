import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAppLocale } from "@/components/viz/intl";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { LevelScale } from "@/components/viz/level-scale";
import { SkillOverlap } from "@/components/viz/skill-overlap";
import type { FloorCheck } from "@/lib/dashboard/floor-check";
import type { GermanCheck } from "@/lib/dashboard/german-check";
import type { SkillMatch } from "@/lib/dashboard/skills";
import type { TrapCheckView } from "@/lib/traps/view";
import { formatSalary, UNKNOWN } from "@/lib/format/numbers";
import { cn } from "@/lib/utils";

export interface ChecksPanelProps {
  german: GermanCheck;
  /** The market's local language as the page names it; null = the market has no language step (the block is left out). */
  languageName?: string | null;
  /** Points the German requirement cost, once the job is scored; null before. */
  germanPenalty: number | null;
  /** The detail lines of the German scoring (`GermanPanel`), shown under the scale once the job is scored. */
  germanDetail?: ReactNode;
  skills: readonly SkillMatch[];
  /** `me.yaml` lists at least one skill. */
  profileHasSkills: boolean;
  floor: FloorCheck;
  /** The AI trap row; absent when traps.yaml is off. */
  traps?: TrapCheckView | null;
}

function Cap({ children }: { children: ReactNode }) {
  return <span className="text-cap text-ink-3 text-cap-style">{children}</span>;
}

/**
 * "Checks" card of the detail page: your German against the one the posting asks for (A1-C2 scale, the gap hatched),
 * the skills it lists against your profile (cells + all the skills), and the stated salary against your floor.
 * Every unknown stays unknown: no German requirement written means no guess, no salary means no verdict (C3).
 */
export function ChecksPanel({ german, germanPenalty, germanDetail, skills, profileHasSkills, floor, traps, languageName = null }: ChecksPanelProps) {
  const language = languageName ?? "";
  const t = useTranslations("dashboard.detail.checks");
  const tTraps = useTranslations("aiTraps.checks");
  const locale = useAppLocale();
  const money = (amount: number | null, approx = false): string => (amount === null ? UNKNOWN : (formatSalary({ min: amount, max: amount, approx, currency: floor.currency }, { locale }) ?? UNKNOWN));
  const mineText = german.native ? t("german.native") : (german.mine ?? "");

  const germanLine: { tone: "good" | "bad" | "dim"; text: string } = (() => {
    switch (german.state) {
      case "not_required":
        return { tone: "good", text: t("german.not_required", { language }) };
      case "preferred":
        return { tone: "dim", text: t("german.preferred", { language }) };
      case "unknown":
        return { tone: "dim", text: t("german.unknown", { language }) };
      case "met":
        return { tone: "good", text: t("german.met", { mine: mineText, required: german.required ?? "", language }) };
      case "gap":
        return { tone: "bad", text: t("german.gap", { n: german.gap, mine: mineText, required: german.required ?? "" }) };
      case "no_german":
        return { tone: "bad", text: t("german.no_german", { required: german.required ?? "", language }) };
    }
  })();

  return (
    <div className="flex flex-col gap-1.5" data-testid="checks-panel">
      {languageName !== null ? (
        <>
          <Cap>{t("german.title", { language })}</Cap>
          <LevelScale mine={german.mine} required={german.required} />
          <span className={cn("text-data font-mono", germanLine.tone === "good" && "text-good", germanLine.tone === "bad" && "text-bad", germanLine.tone === "dim" && "text-ink-2")} data-testid="german-check" data-state={german.state}>
            {germanLine.text}
            {germanPenalty !== null && germanPenalty > 0 && german.state !== "met" ? ` · ${t("german.penalty", { points: germanPenalty })}` : ""}
          </span>
          {germanDetail ? <div className="mt-1">{germanDetail}</div> : null}
        </>
      ) : null}

      <span className={cn("block", languageName !== null && "mt-2.5")}>
        <Cap>{t("skills.title")}</Cap>
      </span>
      {skills.length === 0 ? (
        <span className="text-data text-ink-2 font-mono" data-testid="skills-none">
          {t("skills.none")}
        </span>
      ) : profileHasSkills ? (
        <SkillOverlap skills={skills} />
      ) : (
        <span className="text-data text-ink-2 font-mono" data-testid="skills-no-profile">
          {t("skills.noProfile")}{" "}
          <Link href="/me" className="text-primary-foreground bg-hi rounded-cell px-1 font-semibold underline-offset-4 hover:underline">
            {t("skills.profileLink")}
          </Link>
        </span>
      )}
      {skills.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("skills.all")} data-testid="skills">
          {skills.map((skill) => (
            <li key={skill.name}>
              <Badge variant={!profileHasSkills ? "skill" : skill.have ? "skill-hit" : "skill-miss"} data-have={profileHasSkills ? skill.have : undefined}>
                {skill.name}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <span className="mt-2.5 block">
        <Cap>{t("floor.title")}</Cap>
      </span>
      <span className="text-data font-mono" data-testid="floor-check" data-state={floor.state}>
        {floor.state === "pass" ? (
          <>
            {money(floor.top, floor.approx)} ≥ {money(floor.floor)} <span className="text-good">✓</span>
          </>
        ) : floor.state === "fail" ? (
          <>
            {money(floor.top, floor.approx)} &lt; {money(floor.floor)} <span className="text-bad">✕</span> <span className="text-ink-2">{t("floor.fail")}</span>
          </>
        ) : (
          <span className="text-ink-2">{floor.state === "no_floor" ? t("floor.no_floor") : floor.state === "other_region" ? t("floor.other_region") : t("floor.no_salary")}</span>
        )}
      </span>

      {traps ? (
        <>
          <span className="mt-2.5 block">
            <Cap>{tTraps("title")}</Cap>
          </span>
          <span className="text-data font-mono" data-testid="trap-check" data-state={traps.state}>
            {traps.state === "found" ? (
              <a href="#h-traps" className="text-bad font-semibold underline-offset-4 hover:underline">
                {tTraps("found", { count: traps.count })}
              </a>
            ) : traps.state === "none" ? (
              <span className="text-good">{tTraps("none", { ai: traps.aiChecked ? tTraps("aiChecked") : tTraps("aiNotChecked") })}</span>
            ) : (
              <span className="text-ink-2">{tTraps("notScanned")}</span>
            )}
          </span>
        </>
      ) : null}
    </div>
  );
}
