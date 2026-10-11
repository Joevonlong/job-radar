import { z, type ZodType } from "zod";

import { AiSchemaError } from "./errors";
import type { JsonSchemaObject } from "./types";

const cache = new WeakMap<ZodType, JsonSchemaObject>();

/**
 * zod → JSON Schema (zod 4's built-in converter, `io: "output"` = the shape the model must produce).
 * The root must be an object: every provider (tool input, `--json-schema`, `--output-schema`)
 * requires one. The `$schema` marker is dropped because some of them reject it.
 *
 * Note for schema authors: OpenAI-style strict schemas (Codex `--output-schema`) need every
 * property to be required, so model "absent" as `.nullable()` rather than `.optional()`.
 */
export function toJsonSchema(schema: ZodType): JsonSchemaObject {
  const cached = cache.get(schema);
  if (cached) return cached;
  let raw: Record<string, unknown>;
  try {
    raw = z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }) as Record<string, unknown>;
  } catch (error) {
    throw new AiSchemaError("schema cannot be converted to JSON Schema", error);
  }
  const { $schema: _ignored, ...rest } = raw;
  void _ignored;
  if (rest.type !== "object") throw new AiSchemaError("the output schema must be an object at its root");
  const result = rest as JsonSchemaObject;
  cache.set(schema, result);
  return result;
}
