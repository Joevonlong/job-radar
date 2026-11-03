import { ChannelError } from "@/lib/channels/errors";
import type { ChannelRegistry } from "@/lib/channels/registry";
import { normalizedPostingDraftSchema } from "@/lib/channels/types";
import type { PipelineConfig } from "@/lib/config";

import { normalizeDraft, type NormalizedJob } from "./normalize";

/** Longest error text kept in a log line or a result sample. */
export const MAX_REASON_CHARS = 300;

export function describeError(error: unknown): string {
  if (error instanceof ChannelError) return `${error.code}: ${error.message}`.slice(0, MAX_REASON_CHARS);
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
  return "unknown error";
}

/** Draft validation problems as "field: message" lines, without the offending values. */
function describeDraftIssues(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Channel `parse` + draft validation + normalization; failures become a reason string. */
export function parseAndNormalize(
  raw: { channelId: string; payloadJson: unknown },
  options: { registry: ChannelRegistry; config: PipelineConfig },
): { ok: true; normalized: NormalizedJob; family: string } | { ok: false; reason: string } {
  const channel = options.registry.get(raw.channelId);
  if (!channel) return { ok: false, reason: `unknown channel "${raw.channelId}" (not registered in this process)` };
  let draft;
  try {
    const parsed = normalizedPostingDraftSchema.safeParse(channel.parse(raw.payloadJson));
    if (!parsed.success) return { ok: false, reason: `invalid draft from ${raw.channelId}: ${describeDraftIssues(parsed.error)}`.slice(0, MAX_REASON_CHARS) };
    draft = parsed.data;
  } catch (error) {
    return { ok: false, reason: `parse failed: ${describeError(error)}`.slice(0, MAX_REASON_CHARS) };
  }
  try {
    return { ok: true, normalized: normalizeDraft(draft, options.config), family: channel.family };
  } catch (error) {
    return { ok: false, reason: `normalize failed: ${describeError(error)}`.slice(0, MAX_REASON_CHARS) };
  }
}
