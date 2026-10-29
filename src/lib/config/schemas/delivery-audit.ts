import { z } from "zod";

import { CHANNEL_KINDS } from "@/lib/channels/types";

export const deliveryAuditSchema = z.strictObject({
  scope: z.strictObject({
    channel_kinds: z.array(z.enum(CHANNEL_KINDS)),
    exclude_channels: z.array(z.string()),
  }),
  checkpoint: z.strictObject({ write_timeout_ms: z.number().int().positive() }),
  retention: z.strictObject({
    days: z.number().int().min(1),
    warn_bytes: z.number().int().positive(),
  }),
  prune: z.strictObject({
    every_minutes: z.number().int().positive(),
    batch_size: z.number().int().positive(),
    statement_timeout_ms: z.number().int().positive(),
  }),
});

export type DeliveryAuditConfig = z.infer<typeof deliveryAuditSchema>;
