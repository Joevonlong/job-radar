import type { getFormatter } from "next-intl/server";

import { formatUsdAmount } from "@/lib/format/numbers";
import { ageParts } from "@/lib/settings/age";

export type Formatter = Awaited<ReturnType<typeof getFormatter>>;

/** `$1.20`, or `$0.0123` for sub-dollar amounts so small AI costs do not all read as $0.00. */
export function formatUsd(format: Formatter, usd: number): string {
  return formatUsdAmount(format, usd);
}

/** `Oct 7, 14:03` in the schedule's time zone. */
export function formatWhen(format: Formatter, date: Date, timeZone: string): string {
  return format.dateTime(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
}

export { ageParts };
