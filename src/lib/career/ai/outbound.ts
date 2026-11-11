import { OutboundMismatch, type OutboundText } from "@/lib/outbound/outbound";
import { CareerStoreError } from "../contact/errors";
import { confirmCareerText, outboundCareerText } from "../contact/scrub";
import { neutralizeCareerSource } from "./source";

export function toOutbound(text: string): OutboundText { return outboundCareerText(text); }
export function confirmedOutbound(text: string): OutboundText {
  try {
    if (neutralizeCareerSource(text) !== text) throw new OutboundMismatch();
    return confirmCareerText(text);
  } catch (error) {
    if (error instanceof OutboundMismatch) throw new CareerStoreError("scrub_mismatch");
    throw error;
  }
}
