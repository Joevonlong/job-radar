import type { PipelineConfig } from "@/lib/config";

import { compileRules } from "./rules";

/** Skill names (pipeline.yaml `skills`) mentioned in `text`, in config order. */
export function extractSkills(text: string, config: PipelineConfig): string[] {
  return compileRules(config)
    .skills.filter((s) => s.pattern.test(text))
    .map((s) => s.name);
}
