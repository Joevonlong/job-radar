import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { makeTempConfig } from "../config/helpers";
import { careerProfileSchema, type CareerProfile, type Text } from "@/lib/career/schema/profile";
import { careerSchema } from "@/lib/config/schemas/career";

export function text(value = "Built a service"): Text {
  return {
    id: "",
    primary: "",
    wordings: [
      {
        id: "",
        text: value,
        lang: null,
        label: null,
        origin: "manual",
        from_document: null,
        from_story: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  };
}
export function profile(value = "Built a service"): CareerProfile {
  return careerProfileSchema.parse({
    experience: [{ id: "", company: "Example", role: text("Engineer"), bullets: [text(value)] }],
  });
}
export function tempCareer(overrides: Record<string, unknown> = {}) {
  const temp = makeTempConfig();
  fs.writeFileSync(
    path.join(temp.configDir, "career.yaml"),
    stringify({ config_version: 2, ...careerSchema.parse({ enabled: true, ...overrides }) }),
  );
  return temp;
}
