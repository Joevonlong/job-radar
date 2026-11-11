import type { z } from "zod";
import type { JobCard } from "@/lib/db/queries/types";
import type { McpContext } from "../context";
import { toReadJobDto } from "../dto/read-jobs";
import { readTextCleaner } from "../read-guard";
import { readTraps, truncationNotice } from "./shared";

export async function readCards(ctx: McpContext, cards: readonly JobCard[]) {
  const clean = readTextCleaner(readTraps(ctx), ctx.text("notice.redacted"));
  return cards.map((card) => toReadJobDto(card, clean));
}

export function readNotices(ctx: McpContext, returned: number, total: number, limit: number, withheld: boolean) {
  return [ctx.text("notice.thirdParty"), ...(withheld ? [ctx.text("notice.derivedWithheld")] : []), ...(total > returned ? [truncationNotice(ctx, returned, total, limit)] : [])];
}

/** Applies the configured result cap to nested collections after the DTO allow-list has been checked. */
export function limitReadOutput<T extends { notices: string[] }>(ctx: McpContext, schema: z.ZodType<T>, value: T, limit: number, uncappedPaths: readonly string[] = []): T {
  const parsed = schema.parse(value);
  const notices = [...parsed.notices];
  let truncated = false;
  const visit = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) {
      if (!uncappedPaths.includes(path) && value.length > limit) { truncated = true; notices.push(truncationNotice(ctx, limit, value.length, limit)); }
      return (uncappedPaths.includes(path) ? value : value.slice(0, limit)).map((entry) => visit(entry, path));
    }
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "notices" ? entry : visit(entry, path ? `${path}.${key}` : key)]));
    return value;
  };
  const capped = schema.parse(visit(parsed, ""));
  return schema.parse({ ...capped, ...("truncated" in capped ? { truncated: capped.truncated === true || truncated } : {}), notices: [...new Set(notices)] });
}
