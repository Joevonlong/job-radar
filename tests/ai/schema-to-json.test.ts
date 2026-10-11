// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AiSchemaError } from "@/lib/ai/errors";
import { toJsonSchema } from "@/lib/ai/schema-to-json";

describe("toJsonSchema", () => {
  const schema = z.object({
    score: z.number().int().min(0).max(100),
    reasons: z.array(z.string()),
    level: z.enum(["a", "b"]).nullable(),
  });

  it("converts an object schema and drops the $schema marker", () => {
    const json = toJsonSchema(schema);
    expect(json).not.toHaveProperty("$schema");
    expect(json.type).toBe("object");
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(["score", "reasons", "level"]);
    expect(json.properties).toMatchObject({ score: { type: "integer", minimum: 0, maximum: 100 } });
  });

  it("returns the same object for the same schema (cached)", () => {
    expect(toJsonSchema(schema)).toBe(toJsonSchema(schema));
  });

  it("rejects a non-object root", () => {
    expect(() => toJsonSchema(z.array(z.string()))).toThrow(AiSchemaError);
  });

  it("rejects schemas JSON Schema cannot express", () => {
    expect(() => toJsonSchema(z.object({ at: z.date() }))).toThrow(AiSchemaError);
  });
});
