import { expect, it } from "vitest";
import { currentScoresCheck } from "@/lib/ops/doctor/checks/current-scores";
import { makeContext, only } from "./helpers";
it.each(["en", "zh"] as const)("reports missing, failed repair and healthy state in %s", async (locale) => {
  const context = (present: boolean, remaining: number) => makeContext({ locale, probes: { currentScores: async () => ({ present, remaining, rows: 12, checkedAt: "2026-01-15", differences: 3 }) } });
  expect((await only(currentScoresCheck, context(false, 0))).status).toBe("warn");
  expect((await only(currentScoresCheck, context(true, 1))).status).toBe("fail");
  const result = await only(currentScoresCheck, context(true, 0)); expect(result.status).toBe("ok"); expect(result.detail).toContain("12"); expect(result.detail).toContain("2026-01-15");
});
