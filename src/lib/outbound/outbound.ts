import { scrubFinal, scrubOutbound, type StoredValues } from "./scrub";
export type { StoredValues } from "./scrub";

export type OutboundText = string & { readonly __outbound: unique symbol };
export const NO_STORED_VALUES: StoredValues = { values: [] };

export class OutboundMismatch extends Error {
  constructor() { super("scrub_mismatch"); this.name = "OutboundMismatch"; }
}
export function toOutbound(text: string, stored: StoredValues): OutboundText {
  return scrubOutbound(text, stored).text as OutboundText;
}
export function confirmedOutbound(text: string, stored: StoredValues): OutboundText {
  if (scrubFinal(text, stored).text !== text) throw new OutboundMismatch();
  return text as OutboundText;
}
