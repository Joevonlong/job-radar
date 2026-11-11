import type { z } from "zod";
import { readJobTexts } from "@/lib/db/queries/read-texts";
import type { JobCard } from "@/lib/db/queries/types";
import type { McpContext } from "../context";
import { toReadJobDto } from "../dto/read-jobs";
import { readTextAccess } from "../read-guard";
import { truncationNotice } from "./shared";

export async function readCards(ctx: McpContext, cards: readonly JobCard[]) {
  const texts = new Map((await readJobTexts(ctx.db, cards.map((card) => card.id))).map((job) => [job.jobId, job]));
  return Promise.all(cards.map(async (card) => toReadJobDto(card, await readTextAccess(ctx, texts.has(card.id) ? [texts.get(card.id)!] : []))));
}

export function readNotices(ctx: McpContext, returned: number, total: number, limit: number, withheld: boolean) {
  return [ctx.text("notice.thirdParty"), ...(withheld ? [ctx.text("notice.derivedWithheld")] : []), ...(total > returned ? [truncationNotice(ctx, returned, total, limit)] : [])];
}

/** Applies the configured result cap to nested collections after the DTO allow-list has been checked. */
export function limitReadOutput<T extends { notices: string[] }>(ctx: McpContext, schema: z.ZodType<T>, value: T, limit: number): T {
  const parsed = schema.parse(value);
  const notices = [...parsed.notices];
  let truncated = false;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (value.length > limit) { truncated = true; notices.push(truncationNotice(ctx, limit, value.length, limit)); }
      return value.slice(0, limit).map(visit);
    }
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "notices" ? entry : visit(entry)]));
    return value;
  };
  const capped = schema.parse(visit(parsed));
  return schema.parse({ ...capped, ...("truncated" in capped ? { truncated: capped.truncated === true || truncated } : {}), notices: [...new Set(notices)] });
}
