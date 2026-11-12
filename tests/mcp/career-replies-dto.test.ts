// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getCareerProfileOutput, listCareerDocumentsOutput, getCareerDocumentOutput, checkCareerDocumentOutput, listRepliesOutput } from "@/lib/mcp/dto";

/** Record every object field set, including nested unions; every object must reject additional properties. */
function fieldSets(schema: unknown, location = "$", result: Record<string, string[]> = {}): Record<string, string[]> {
  if (!schema || typeof schema !== "object") return result;
  const node = schema as Record<string, unknown>;
  if (node.properties && typeof node.properties === "object") {
    expect(node.additionalProperties, location).toBe(false);
    result[location] = Object.keys(node.properties).sort();
  }
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value)) value.forEach((child, index) => fieldSets(child, `${location}.${key}[${index}]`, result));
      else fieldSets(value, `${location}.${key}`, result);
    }
  }
  return result;
}

describe("career and reply output allow-lists", () => {
  it.each(Object.entries({ get_career_profile: getCareerProfileOutput, list_career_documents: listCareerDocumentsOutput, get_career_document: getCareerDocumentOutput, check_career_document: checkCareerDocumentOutput, list_replies: listRepliesOutput }))("pins every field of %s", (name, schema) => {
    expect(fieldSets(z.toJSONSchema(schema))).toMatchSnapshot(name);
    expect(schema.safeParse({ notices: [], localPath: "/private/sentinel" }).success).toBe(false);
  });
});
