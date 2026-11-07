import { expect, it } from "vitest";
import { careerSchema } from "@/lib/config/schemas/career";
import { writerSchema } from "@/lib/config/schemas/writer";
import { outboundImportFields } from "@/lib/config/schemas/outbound-import";

it("shares the same privacy vocabulary fields across extraction schemas", () => {
  const career = careerSchema.shape.import.unwrap().shape;
  const writer = writerSchema.shape.import.unwrap().shape;
  expect(writer.title_words).toBe(outboundImportFields.title_words);
  expect(career.title_words).toBe(writer.title_words);
  expect(career.sensitive_labels).toBe(writer.sensitive_labels);
  const vocabulary = { title_words: ["Biography"], sensitive_labels: ["Private label"] };
  for (const schema of [writerSchema, careerSchema]) {
    expect(schema.parse({ import: vocabulary }).import).toMatchObject(vocabulary);
    expect(schema.safeParse({ import: { title_words: [""] } }).success).toBe(false);
    expect(schema.safeParse({ import: { sensitive_labels: ["x".repeat(201)] } }).success).toBe(false);
  }
});
