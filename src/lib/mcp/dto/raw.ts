import { z } from "zod";

import type { RawPostingForJob } from "@/lib/db/queries/raw-postings";
import { truncateText } from "../guard";
import { readSourceUrl } from "../read-guard";
import { notices, type CleanText } from "./shared";

export const rawPostingDto = z.strictObject({
  channel: z.strictObject({ id: z.string() }),
  url: z.string().nullable(),
  fetched_at: z.iso.datetime(),
  parse_status: z.enum(["pending", "parsed", "parse_failed"]),
  parse_error: z.string().nullable(),
  payload: z.string(),
  truncated: z.boolean(),
  total_chars: z.number().int().nonnegative(),
});

export const getJobRawOutput = z.strictObject({
  notices,
  job_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sources: z.array(rawPostingDto),
  truncated: z.boolean(),
});

/** Payloads are deliberately uncleaned; only metadata goes through the read-text cleaner. */
export function toRawPostingDtos(rows: readonly RawPostingForJob[], limit: number, clean: CleanText) {
  let remaining = limit;
  return rows.map((row) => {
    const payload = JSON.stringify(row.payloadJson);
    const cut = truncateText(payload, remaining);
    remaining -= cut.text.length;
    return rawPostingDto.parse({
      channel: { id: clean(row.channelId) },
      url: readSourceUrl(row.url, clean),
      fetched_at: row.fetchedAt.toISOString(),
      parse_status: row.parseStatus,
      parse_error: row.parseError === null ? null : clean(row.parseError),
      payload: cut.text,
      truncated: cut.truncated,
      total_chars: payload.length,
    });
  });
}
