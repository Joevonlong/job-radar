/** Tracking history exposes actions and clocks, without notes or local paths. */
import { z } from "zod";

const date = z.iso.datetime({ offset: true });

export const trackingBlockDto = z.strictObject({
  application: z.strictObject({ status: z.string(), status_changed_at: date, created_at: date, next_action: z.string().nullable(), next_action_at: date.nullable(), interview_rounds: z.number().int(), history: z.array(z.strictObject({ from: z.string().nullable(), to: z.string(), at: date })) }).nullable(),
  favorite: z.strictObject({ since: date }).nullable(),
  seen: z.boolean(),
  closure: z.strictObject({ auto_status: z.enum(["active", "possibly_closed", "closed"]), reason: z.enum(["manual", "gone", "dormant", "phrase", "possibly"]).nullable(), override: z.strictObject({ action: z.enum(["closed", "open"]), at: date }).nullable(), link_check: z.strictObject({ outcome: z.enum(["alive", "gone", "phrase", "unknown", "robots"]), checked_at: date }).nullable() }),
  filter_override: z.enum(["keep", "exclude"]).nullable(),
});
