"use client";

import { useLayoutEffect, useRef, useState } from "react";

import { Sparkline } from "@/components/viz";

type SparklineProps = Parameters<typeof Sparkline>[0];

/** The narrowest trend still worth drawing; below it the tile keeps the number and the words. */
const MIN_WIDTH = 48;
/** Room for the yellow dot on the newest day (radius 4), so it is not cut at the right edge. */
const DOT_ROOM = 4;

/**
 * A sparkline that never leaves its box: it is as wide as the space left next to the change badge (at most `width`),
 * measured in the browser and re-measured when the tile resizes. The wrapper clips whatever could still overflow
 * sideways, so a trend can never be drawn into the neighbouring card.
 */
export function FitSparkline({ width = 130, ...rest }: SparklineProps) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(width);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setFit(Math.max(MIN_WIDTH, Math.min(width, Math.floor(element.clientWidth) - DOT_ROOM)));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={box} className="flex min-w-0 flex-1 justify-end overflow-x-clip pr-1" data-testid="trend-box">
      <Sparkline {...rest} width={fit} />
    </div>
  );
}
