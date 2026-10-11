import type { z } from "zod";

import type { ChannelContext } from "./types";

/**
 * Details of postings the channel already stored, by external id.
 *
 * `detailOf` takes a stored payload and returns its detail record, or null when the payload has no usable detail
 * (a posting stored without one is fetched again, so a failed fetch heals on a later cycle). Nothing is reused when
 * `enabled` is false (`reuse_known_details`). A failing lookup is logged and answers "nothing known": the caller then
 * fetches every detail as before, so this can only save requests, never lose data.
 */
export async function loadKnownDetails<D>(
  ctx: Pick<ChannelContext, "known" | "logger">,
  input: { enabled: boolean; externalIds: readonly string[]; detailOf: (payload: unknown) => D | null },
): Promise<Map<string, D>> {
  const found = new Map<string, D>();
  if (!input.enabled || input.externalIds.length === 0) return found;
  try {
    const stored = await ctx.known.payloads(input.externalIds);
    for (const [id, payload] of stored) {
      const detail = input.detailOf(payload);
      if (detail !== null) found.set(id, detail);
    }
  } catch (error) {
    ctx.logger.warn("known postings lookup failed, fetching all details", { error: error instanceof Error ? error.message : String(error) });
    found.clear();
  }
  return found;
}

/**
 * `detailOf` for payloads shaped `{ ..., detail }`: the stored `detail` exactly as it was stored (C1; parsing it with `schema`
 * would drop keys the schema does not name), or null when the payload does not match `schema` or holds no detail.
 */
export function storedDetailOf<D>(schema: z.ZodType): (payload: unknown) => D | null {
  return (payload) => {
    if (!schema.safeParse(payload).success) return null;
    const detail = (payload as { detail?: unknown }).detail;
    return detail === null || detail === undefined ? null : (detail as D);
  };
}
