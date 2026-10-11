import Link from "next/link";
import type { ReactNode } from "react";

import { PlayOnView } from "@/components/viz";
import { toneVar, type VizTone } from "@/components/viz/util";
import { cn } from "@/lib/utils";

import "./insights.css";

export interface BarSegment {
  value: number;
  tone: VizTone;
  /** Hatched instead of solid (the part that did not pass / is not counted). */
  hatch?: boolean;
}

export interface BarRow {
  key: string;
  label: ReactNode;
  /** The number at the right; a link when `href` is set. */
  value: string;
  href?: string | null;
  /** Small text after the number (a share, a mean). Rendered as a link when `suffixHref` is set. */
  suffix?: string | undefined;
  suffixHref?: string | null;
  /** Bar segments, left to right; their sum against `max` is the bar length. */
  segments: BarSegment[];
  /** Hover and screen-reader sentence for the whole row. */
  text: string;
}

/** Rows of label, a proportional bar (solid = counted, hatched = the rest) and the numbers: the body of the source, city, tier, stage and reason cards. */
export function BarList({ rows, max, testId }: { rows: readonly BarRow[]; max: number; testId: string }) {
  return (
    <PlayOnView as="div" data-testid={testId}>
      <ul className="ins-hb">
        {rows.map((row, index) => (
          <li key={row.key} className="ins-hb__r jr-tip" data-row={row.key} data-tip={row.text}>
            <span className="ins-hb__l">{row.label}</span>
            <span className="sr-only">{row.text}</span>
            <span className="ins-hb__t" aria-hidden>
              {row.segments
                .filter((segment) => segment.value > 0)
                .map((segment, i) => (
                  <i
                    key={i}
                    className={cn("jr-grow", segment.hatch && "ins-hatch")}
                    style={{ width: `${Math.min(100, (segment.value / Math.max(1e-9, max)) * 100)}%`, "--c": toneVar(segment.tone), "--k": index } as React.CSSProperties}
                  />
                ))}
            </span>
            <span className="ins-hb__v">
              <b>
                {row.href ? <Link href={row.href}>{row.value}</Link> : row.value}
              </b>
              {row.suffix ? (
                <>
                  {" · "}
                  {row.suffixHref ? <Link href={row.suffixHref}>{row.suffix}</Link> : row.suffix}
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </PlayOnView>
  );
}
