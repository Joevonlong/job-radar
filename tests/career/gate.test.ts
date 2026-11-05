import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { reloadConfig } from "@/lib/config/load";
import { readCareerGate } from "@/lib/config/career-gate";
import { careerSchema } from "@/lib/config/schemas/career";
import { writerSchema } from "@/lib/config/schemas/writer";
import { profilePiiWarnings } from "@/components/career/pii";
import { tempCareer, profile } from "./fixtures";

const temps: ReturnType<typeof tempCareer>[] = [];
afterEach(() => {
  temps.reverse().forEach((temp) => temp.cleanup());
  temps.length = 0;
  vi.restoreAllMocks();
});
function temp() {
  const value = tempCareer();
  temps.push(value);
  return value;
}

it("closes on a broken or missing file even after a cached enabled value", async () => {
  const config = temp();
  expect(reloadConfig("career").enabled).toBe(true);
  fs.writeFileSync(path.join(config.configDir, "career.yaml"), "enabled: [broken");
  expect(await readCareerGate()).toEqual({ enabled: false });
  fs.writeFileSync(path.join(config.configDir, "career.yaml"), "enabled: true\n");
  expect(await readCareerGate()).toEqual({ enabled: true });
  fs.unlinkSync(path.join(config.configDir, "career.yaml"));
  expect(await readCareerGate()).toEqual({ enabled: false });
  fs.unlinkSync(path.join(config.defaultsDir, "career.yaml"));
  expect(await readCareerGate()).toEqual({ enabled: false });
});

it.each([false, true].flatMap((writer) => [false, true].map((career) => ({ writer, career }))))(
  "writer=$writer and career=$career are independent",
  async ({ writer, career }) => {
    const config = temp();
    fs.writeFileSync(path.join(config.configDir, "career.yaml"), stringify(careerSchema.parse({ enabled: career })));
    fs.writeFileSync(path.join(config.configDir, "writer.yaml"), stringify(writerSchema.parse({ enabled: writer })));
    expect(await readCareerGate()).toEqual({ enabled: career });
    expect(reloadConfig("writer").enabled).toBe(writer);
  },
);

it("is disabled when career.yaml does not turn it on", async () => {
  const config = temp();
  fs.writeFileSync(path.join(config.configDir, "career.yaml"), "config_version: 2\n");
  expect(careerSchema.parse({}).enabled).toBe(false);
  expect(await readCareerGate()).toEqual({ enabled: false });
});

it("warns about contact-like profile text without blocking schema parsing", () => {
  expect(profilePiiWarnings(profile("Reach me at sentinel@example.invalid or +49 30 1234567"))).toEqual([
    "email",
    "phone",
  ]);
  expect(profilePiiWarnings(profile("Built a service"))).toEqual([]);
});
