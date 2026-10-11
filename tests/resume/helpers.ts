import { configRegistry, type ResumeConfig } from "@/lib/config";

import { shippedYaml } from "../config/helpers";

/** The shipped resume.yaml, optionally edited (re-validated). */
export function resumeConfig(edit: (raw: Record<string, unknown>) => void = () => {}): ResumeConfig {
  const raw = structuredClone(shippedYaml("resume.yaml"));
  edit(raw);
  return configRegistry.resume.schema.parse(raw);
}
