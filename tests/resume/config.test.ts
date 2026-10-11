// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";

const parse = (edit: (raw: Record<string, unknown>) => void) => {
  const raw = structuredClone(shippedYaml("resume.yaml"));
  edit(raw);
  return configRegistry.resume.schema.safeParse(raw);
};

describe("resume.yaml", () => {
  it("ships with every path unset and the JD export under data/exports/jd", () => {
    const config = configRegistry.resume.schema.parse(shippedYaml("resume.yaml"));
    expect(config.resume_kit_path).toBeNull();
    expect(config.master_resume_path).toBeNull();
    expect(config.pdf_dir).toBeNull();
    expect(config.jd_export_dir).toBe("data/exports/jd");
  });

  it("accepts absolute paths and rejects relative or home-relative ones", () => {
    expect(parse((raw) => (raw.resume_kit_path = "/Users/me/resume-kit")).success).toBe(true);
    expect(parse((raw) => (raw.resume_kit_path = "resume-kit")).success).toBe(false);
    expect(parse((raw) => (raw.pdf_dir = "~/Exports")).success).toBe(false);
    expect(parse((raw) => (raw.master_resume_path = "")).success).toBe(false);
  });

  it("rejects unknown keys and non-positive limits", () => {
    expect(parse((raw) => (raw.surprise = 1)).success).toBe(false);
    expect(parse((raw) => (raw.filename_part_max_chars = 0)).success).toBe(false);
  });
});
