import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { loadConfig } from "../src/lib/config/load";
import { calibrate, calibrationSamplesSchema } from "../src/lib/career/tailor/calibration";

const samples = calibrationSamplesSchema.parse(["en", "de"].flatMap((lang) => parse(fs.readFileSync(path.resolve(`tests/fixtures/career/tailor-claims/${lang}.yaml`), "utf8")) as unknown[]));
const settings = loadConfig("career");
console.log("threshold language miss_rate false_alarm_rate missed_must_catch");
for (let step = 8; step <= 19; step++) {
  const threshold = step / 20;
  for (const row of calibrate(samples, settings, threshold)) console.log(`${threshold.toFixed(2)} ${row.lang} ${(row.missRate * 100).toFixed(2)}% ${(row.falseAlarmRate * 100).toFixed(2)}% ${row.missedMustCatch.length}`);
}
