import { describe, expect, it } from "vitest";
import { currentScoresSchema } from "@/lib/config/schemas/current-scores";
const valid = () => ({ backfill: { lock_timeout_ms: 500, statement_timeout_ms: 2000 }, refresh: { lateral_max_jobs: 10 } });
describe("current score configuration", () => {
  it("accepts a complete configuration without injecting defaults", () => { expect(currentScoresSchema.parse(valid())).toEqual(valid()); });
  it.each([
    {}, { ...valid(), unexpected: true }, { ...valid(), backfill: { lock_timeout_ms: 1, statement_timeout_ms: 2000 } },
    { ...valid(), backfill: { lock_timeout_ms: 500, statement_timeout_ms: 600001 } },
    { ...valid(), refresh: { lateral_max_jobs: 0 } }, { ...valid(), refresh: { lateral_max_jobs: 100001 } },
  ])("rejects missing, unknown and out-of-range values", (value) => { expect(currentScoresSchema.safeParse(value).success).toBe(false); });
});
