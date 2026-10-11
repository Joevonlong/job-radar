import { useTranslations } from "next-intl";

import "./viz.css";
import { PlayOnView } from "./motion";
import { cx, stepStyle } from "./util";

export type UptimeState = "ok" | "warn" | "fail";

export interface UptimeStripProps {
  /** Outcome of each recent cycle, oldest first. Null: the cycle has no data for this source. */
  states: ReadonlyArray<UptimeState | null | undefined>;
  /** How many cycles the strip shows (`ui.yaml: health_cycles`). Older ones are cut; missing ones are dashed empty cells. Default: all. */
  count?: number;
  /** Print `12/14 正常` next to the strip (default). */
  showSummary?: boolean;
  className?: string;
}

/** Last N cycles as a strip of blocks: green = ok, yellow with hatch = degraded, red = failed, dashed = no data. */
export function UptimeStrip({ states, count, showSummary = true, className }: UptimeStripProps) {
  const t = useTranslations("viz");
  const total = count ?? states.length;
  const recent = states.slice(Math.max(0, states.length - total));
  const padded: Array<UptimeState | null> = [...Array.from({ length: Math.max(0, total - recent.length) }, () => null), ...recent.map((state) => state ?? null)];
  const ok = padded.filter((state) => state === "ok").length;
  const warn = padded.filter((state) => state === "warn").length;
  const fail = padded.filter((state) => state === "fail").length;
  const known = ok + warn + fail;
  // a channel that never ran has no record: "no records", never "0/0 OK"
  const summary = known === 0 ? t("uptime.noRecords") : t("uptime.summary", { ok, total: known });
  return (
    <PlayOnView className={cx("jr-up-wrap", className)}>
      <span className="jr-up" role="img" aria-label={t("uptime.aria", { total: known, ok, warn, fail })}>
        {padded.map((state, index) => (
          <i
            key={index}
            className="jr-tip"
            data-state={state ?? "none"}
            style={stepStyle(index)}
            data-tip={t("uptime.tip", { n: padded.length - index, state: t(`uptime.${state ?? "none"}`) })}
          />
        ))}
      </span>
      {showSummary ? <span className="jr-up__sum">{summary}</span> : null}
    </PlayOnView>
  );
}
