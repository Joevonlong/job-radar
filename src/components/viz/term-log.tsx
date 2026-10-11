import { useTranslations } from "next-intl";

import "./viz.css";
import { PlayOnView } from "./motion";
import { cssVars, cx } from "./util";

export interface TermLine {
  text: string;
  tone?: "ink" | "amber" | "green" | "dim";
  /** Dim prefix such as a time (`17:00`). */
  prefix?: string;
}

export interface TermLogProps {
  lines: readonly TermLine[];
  /** Blinking block cursor after the last line (one of the four infinite animations). */
  cursor?: boolean;
  className?: string;
}

const TONE_CLASS: Record<NonNullable<TermLine["tone"]>, string | undefined> = { ink: undefined, amber: "jr-term__amber", green: "jr-term__green", dim: "jr-term__dim" };

/** Run log in a terminal block: lines are typed out one after the other when it scrolls into view. */
export function TermLog({ lines, cursor = true, className }: TermLogProps) {
  const t = useTranslations("viz");
  return (
    <PlayOnView as="div" className={cx("jr-term", className)} role="log" aria-label={t("termlog.aria")}>
      {lines.map((line, index) => (
        <span key={index} className={cx("jr-term__line", TONE_CLASS[line.tone ?? "ink"], cursor && index === lines.length - 1 && "jr-term__cursor")}>
          {line.prefix ? <span className="jr-term__dim">{line.prefix} </span> : null}
          <span className="jr-term__txt" style={cssVars({ "--k": index, "--len": Math.max(1, line.text.length) })}>
            {line.text}
          </span>
        </span>
      ))}
    </PlayOnView>
  );
}
