/**
 * jsdom does not upgrade NumberFlow's custom element (no shadow-DOM layout, no Web Animations), so a value change
 * throws inside the library. The viz tests swap it for a plain element that writes what the roll ends on:
 *
 *   vi.mock("@number-flow/react", () => import("./number-flow-mock").then((m) => m.numberFlowMock));
 *
 * The real roll is checked in the browser on /dev/viz.
 */
import type { ReactElement } from "react";

interface MockProps {
  value: number;
  format?: Intl.NumberFormatOptions;
  locales?: string;
  prefix?: string;
  suffix?: string;
}

function NumberFlowMock({ value, format, locales, prefix = "", suffix = "" }: MockProps): ReactElement {
  return (
    <span data-number-flow aria-hidden>
      {prefix}
      {new Intl.NumberFormat(locales, format).format(value)}
      {suffix}
    </span>
  );
}

export const numberFlowMock = { default: NumberFlowMock };
