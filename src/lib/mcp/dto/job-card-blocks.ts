/** List cards expose only the compact match and tracking whitelists. */
import { z } from "zod";

export const cardMatchBlockDto = z.strictObject({
  summary: z.string().nullable(),
  summary_lang: z.string().nullable(),
  summary_withheld: z.enum(["traps_disabled", "settings_unreadable", "not_scanned", "findings_unreadable"]).nullable(),
  filter_result: z.string().nullable(),
  filter_reasons: z.array(z.string()),
});

export const cardTrackingBlockDto = z.strictObject({
  status: z.string(),
  favorite: z.boolean(),
  seen: z.boolean(),
});
