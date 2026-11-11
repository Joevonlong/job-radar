import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { redactProfile, redactedProfileSchema } from "@/lib/career/contact/redact-profile";
import { careerOutboundScrubber, scrubCareerOutbound } from "@/lib/career/contact/scrub";
import { redactDocument, redactedDocumentSchema } from "@/lib/career/document/redact";
import { documentSchema } from "@/lib/career/schema/document";
import { careerProfileSchema, profileContent } from "@/lib/career/schema/profile";
import { allFieldsExample, contactSentinels, sentinels } from "./redaction-fixtures";
import { tempCareer } from "./fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => {
  temp = tempCareer({ import: { stored_value_min_chars: 3 } });
  fs.mkdirSync(path.join(temp.profileDir, "career"), { recursive: true });
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify(contactSentinels));
});
afterEach(() => { vi.restoreAllMocks(); temp.cleanup(); });

function sameStructure(before: unknown, after: unknown) {
  if (Array.isArray(before)) {
    expect(Array.isArray(after)).toBe(true);
    expect(after).toHaveLength(before.length);
    before.forEach((item, index) => sameStructure(item, (after as unknown[])[index]));
  } else if (before !== null && typeof before === "object") {
    expect(Object.keys(after as object).sort()).toEqual(Object.keys(before).sort());
    for (const [key, value] of Object.entries(before)) sameStructure(value, (after as Record<string, unknown>)[key]);
  } else if (typeof before !== "string" || !sentinels.some((sentinel) => before.includes(sentinel))) {
    expect(after).toEqual(before);
  }
}

it.each(sentinels)("scrubs every schema string field containing %s without dropping structure", (sentinel) => {
  const doc = documentSchema.parse(allFieldsExample(documentSchema, sentinel));
  const profile = careerProfileSchema.parse(allFieldsExample(careerProfileSchema, sentinel));
  profile.adopted_entries = ["123:summary"];
  const result = redactDocument(doc);
  const resultProfile = redactProfile(profile);
  for (const value of sentinels) expect(JSON.stringify({ result, resultProfile })).not.toContain(value);
  sameStructure(doc, result);
  sameStructure(profileContent(profile), resultProfile);
  expect(resultProfile).not.toHaveProperty("adopted_entries");
  expect(redactedDocumentSchema.parse(result)).toEqual(result);
  expect(redactedProfileSchema.parse(resultProfile)).toEqual(resultProfile);
  expect(result.experience[0]?.url).toBe("[link]");
  expect(resultProfile.headline?.wordings[0]?.label).toContain("[");
});

it("covers every claim-target branch, including the free field and value strings", () => {
  const doc = documentSchema.parse(allFieldsExample(documentSchema));
  const first = doc.claims[0]!;
  doc.claims = [
    first,
    { ...first, id: "clm_bbbbbbbbbb", target: { entry: doc.experience[0]!.id, field: contactSentinels.email, value: contactSentinels.name } },
    { ...first, id: "clm_cccccccccc", target: { letter: "recipient" } },
  ];
  const result = redactDocument(documentSchema.parse(doc));
  expect(result.claims[1]?.target).toEqual({ entry: doc.experience[0]!.id, field: "[email]", value: "[name]" });
  sameStructure(doc, result);
});

it("loads contact once for a reusable scrubber and preserves the established rule set", () => {
  const read = vi.spyOn(fs, "readFileSync");
  const scrub = careerOutboundScrubber();
  const afterLoad = read.mock.calls.length;
  const inputs = [...sentinels, "other@example.test +49 555 12345678 https://example.test", "Exampletown"];
  const results = inputs.map(scrub);
  expect(read.mock.calls).toHaveLength(afterLoad);
  expect(read.mock.calls.filter(([file]) => String(file).endsWith("contact.yaml"))).toHaveLength(1);
  expect(results).toEqual(inputs.map((text) => scrubCareerOutbound(text).text));
  expect(results.at(-1)).toBe("Exampletown");
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), "invalid: [");
  expect(scrub(contactSentinels.name)).toBe("[name]");
  expect(() => careerOutboundScrubber()).toThrow();
});

it("preserves short work authorization and availability values", () => {
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify({ ...contactSentinels, work_auth: "EU", availability: "OK" }));
  expect(careerOutboundScrubber()("EU OK Exampletown")).toBe("EU OK Exampletown");
});
