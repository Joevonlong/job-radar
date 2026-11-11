// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getProfileOutput, getInterestsOutput, previewDealBreakersOutput, previewInterestCategoryOutput } from "@/lib/mcp/dto";

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

describe("personal output allow-lists", () => {
  it.each(Object.entries({ get_profile: getProfileOutput, get_interests: getInterestsOutput, preview_deal_breakers: previewDealBreakersOutput, preview_interest_category: previewInterestCategoryOutput }))("pins every field of %s", (name, schema) => {
    expect(fieldSets(z.toJSONSchema(schema))).toMatchSnapshot(name);
    expect(schema.safeParse({ notices: [], localPath: "/private/sentinel" }).success).toBe(false);
  });
});
