import { expect, it } from "vitest";
import { matchExperience, normalizeCareerText } from "@/lib/career/extract/match";
import { assignIds } from "@/lib/career/schema/ids";
import { emptyProfile } from "@/lib/career/schema/profile";
import { profile } from "./fixtures";
import { draft } from "./extract-fixtures";

it("matches normalized company, any role wording and the same start date", () => {
  const p = assignIds(profile(), emptyProfile());
  p.experience[0]!.start = "2020";
  const entry = draft().sections.experience[0]!;
  entry.fields.company!.value = " EXAMPLE. ";
  expect(matchExperience(p, entry)).toBe(p.experience[0]!.id);
  entry.fields.start!.value = "2021";
  expect(matchExperience(p, entry)).toBeNull();
  expect(normalizeCareerText("  ＡＣＭＥ—Lab ")).toBe("acme lab");
});
