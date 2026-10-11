import { useTranslations } from "next-intl";

import "./viz.css";
import { cssVars, cx } from "./util";

export type LedTone = "good" | "warn" | "bad" | "idle";

export interface LedProps {
  tone: LedTone;
  /** Breathing light for something that is running now (one of the four infinite animations). */
  live?: boolean;
  /** Text next to the light. Default: the state word. `false`: none (the light then carries it as its accessible name). */
  label?: string | false;
  className?: string;
}

const COLOR: Record<LedTone, string> = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", idle: "var(--grid)" };

/** Status light plus the state in words (a colour alone is never the message). */
export function Led({ tone, live = false, label, className }: LedProps) {
  const t = useTranslations("viz");
  const text = label === false ? null : (label ?? t(`led.${tone}`));
  const dot = (
    <i
      className={cx("jr-led", tone === "idle" && "jr-led--idle", live && "jr-led--live")}
      style={cssVars({ "--c": COLOR[tone] })}
      {...(text === null ? { role: "img", "aria-label": t(`led.${tone}`) } : { "aria-hidden": true })}
      data-tone={tone}
    />
  );
  return (
    <span className={cx("jr jr-led-wrap", className)}>
      {dot}
      {text}
    </span>
  );
}
