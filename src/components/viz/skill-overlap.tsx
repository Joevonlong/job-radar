import { useTranslations } from "next-intl";

import { formatPercent, ratioPercent, UNKNOWN } from "@/lib/format/numbers";

import "./viz.css";
import { PlayOnView } from "./motion";
import { cx, stepStyle } from "./util";

export interface SkillOverlapSkill {
  name: string;
  /** In your profile (`me.yaml`). */
  have: boolean;
}

export interface SkillOverlapProps {
  /** The skills the job asks for. Empty: nothing was listed ("未披露技能"), which is not 0/0. */
  skills: readonly SkillOverlapSkill[];
  className?: string;
}

/** One cell per required skill: yellow = you have it, empty = missing. `4/7 57%` next to it. */
export function SkillOverlap({ skills, className }: SkillOverlapProps) {
  const t = useTranslations("viz");
  const total = skills.length;
  if (total === 0) {
    return (
      <span className={cx("jr jr-ovl jr-ovl--none", className)} role="img" aria-label={t("skills.none")}>
        <span className="jr-ovl__b" aria-hidden />
        <span className="jr-data-sm jr-muted">{t("skills.none")}</span>
      </span>
    );
  }
  const have = skills.filter((skill) => skill.have);
  const names = have.map((skill) => skill.name).join(", ");
  const hit = have.length;
  const tip = hit > 0 ? t("skills.tip", { hit, total, names }) : t("skills.tipNone", { hit, total });
  return (
    <PlayOnView className={cx("jr-ovl jr-tip", className)} role="img" aria-label={`${t("skills.aria", { hit, total })}${hit > 0 ? `: ${names}` : ""}`} data-tip={tip}>
      <span className="jr-ovl__b" aria-hidden>
        {skills.map((skill, index) => (
          <i key={`${skill.name}-${index}`} className={skill.have ? "jr-on" : undefined} style={stepStyle(index)} />
        ))}
      </span>
      <b>
        {hit}/{total}
      </b>
      <span className="jr-data-sm jr-muted">{formatPercent(ratioPercent(hit, total)) || UNKNOWN}</span>
    </PlayOnView>
  );
}
