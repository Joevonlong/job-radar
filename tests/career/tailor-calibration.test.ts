import fs from "node:fs";
import { parse } from "yaml";
import { expect, test } from "vitest";
import { calibrate, calibrationSamplesSchema } from "@/lib/career/tailor/calibration";
import { tailorSettings } from "./tailor-fixtures";

const MEASURED = { en: { missRate: 0, falseAlarmRate: 0 }, de: { missRate: 0, falseAlarmRate: 0.08 } } as const;
const THRESHOLD = 0.7;
test("fictional calibration rates do not regress and all mandatory counterexamples are caught", () => {
  const samples = calibrationSamplesSchema.parse(["en", "de"].flatMap((lang) => parse(fs.readFileSync(`tests/fixtures/career/tailor-claims/${lang}.yaml`, "utf8")) as unknown[]));
  for (const lang of ["en", "de"] as const) {
    const subset = samples.filter((sample) => sample.lang === lang);
    expect(subset.length).toBeGreaterThanOrEqual(60);
    for (const [label, minimum] of [["supported", 25], ["new_duty", 20], ["new_skill", 10], ["cross_language", 5]] as const) expect(subset.filter((sample) => sample.label === label).length).toBeGreaterThanOrEqual(minimum);
    const row = calibrate(subset, tailorSettings(), THRESHOLD)[0]!;
    console.log(`calibration ${lang}: miss ${(row.missRate * 100).toFixed(2)}%, false alarm ${(row.falseAlarmRate * 100).toFixed(2)}%`);
    expect(row.missRate).toBeLessThanOrEqual(MEASURED[lang].missRate);
    expect(row.falseAlarmRate).toBeLessThanOrEqual(MEASURED[lang].falseAlarmRate);
    expect(row.missedMustCatch).toEqual([]);
  }
});
