import { useTranslations } from "next-intl";

import "./viz.css";
import { PlayOnView } from "./motion";
import { cx, stepStyle } from "./util";

/** CEFR levels, lowest first. */
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export interface LevelScaleProps {
  /** Your level (`me.yaml`). Null: not set - the cells stay empty and say so. */
  mine: CefrLevel | null | undefined;
  /** The level the job asks for; omit when it asks for none. */
  required?: CefrLevel | null | undefined;
  className?: string;
}

/** A1 to C2 as six steps: solid = you, red frame = what is asked, hatched = the gap in between. */
export function LevelScale({ mine, required, className }: LevelScaleProps) {
  const t = useTranslations("viz");
  const mineIndex = mine ? CEFR_LEVELS.indexOf(mine) : -1;
  const requiredIndex = required ? CEFR_LEVELS.indexOf(required) : -1;
  const gap = mineIndex >= 0 && requiredIndex > mineIndex ? requiredIndex - mineIndex : 0;

  const tip = !mine
    ? required
      ? t("level.tipRequiredOnly", { required })
      : t("level.notSet")
    : required
      ? `${t("level.tipRequired", { mine, required })}${gap > 0 ? ` · ${t("level.gap", { n: gap })}` : ""}`
      : t("level.tip", { mine });
  const aria = !mine ? t("level.ariaNone") : required ? `${t("level.ariaRequired", { mine, required })}${gap > 0 ? t("level.ariaGap", { n: gap }) : ""}` : t("level.aria", { mine });

  return (
    <PlayOnView className={cx("jr-lvl jr-tip", !mine && "jr-lvl--unset", className)} role="img" aria-label={aria} data-tip={tip} data-gap={gap}>
      {CEFR_LEVELS.map((level, index) => {
        const isMine = index === mineIndex;
        const isRequired = index === requiredIndex;
        const state = index <= mineIndex ? "jr-on" : mineIndex >= 0 && index <= requiredIndex ? "jr-gap" : "";
        const caption = isMine && isRequired ? `${t("level.you")}/${t("level.required")}` : isMine ? t("level.you") : isRequired ? t("level.required") : "";
        return (
          <span key={level}>
            <em aria-hidden>{caption}</em>
            <i className={cx(state, isRequired && "jr-req")} style={stepStyle(index)}>
              {level}
            </i>
          </span>
        );
      })}
    </PlayOnView>
  );
}
