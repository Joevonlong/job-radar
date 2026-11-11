import { z } from "zod";
import { careerOutboundScrubber } from "../contact/scrub";
import { redactStructure } from "../contact/redact-structure";
import { buildDocumentSchema, type CareerDocument } from "../schema/document";
import { CAREER_FILE_BOUNDS } from "../schema/profile";

export const redactedDocumentSchema = buildDocumentSchema(
  z.string().max(CAREER_FILE_BOUNDS.textChars).nullable().default(null),
);

export function redactDocument(document: CareerDocument, scrub = careerOutboundScrubber()) {
  return redactedDocumentSchema.parse(redactStructure(document, scrub));
}
