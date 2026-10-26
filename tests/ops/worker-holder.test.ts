// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { EvidenceConnection } from "@/lib/db/repos/ai-worker-evidence";
import { workerHolder } from "@/lib/db/repos/ai-worker-holder";

const expected = { pid: 4242, host: "worker.invalid" };

function connection(application: string | null | undefined, visible = true): EvidenceConnection {
  // The SQL transport is the boundary: run the real holder query and comparator against complete pg_stat_activity rows.
  const sql = vi.fn().mockResolvedValue(application === undefined ? [] : [{
    application_name: application,
    backend_start: visible ? new Date("2026-01-01T00:00:00Z") : null,
    backend_start_exact: visible ? "2026-01-01T00:00:00.000000Z" : null,
  }]);
  return { sql } as unknown as EvidenceConnection;
}

describe("worker holder identity comparison", () => {
  it.each([29, 80])("recognizes the expected worker with a %i-byte host, including application_name truncation", async (length) => {
    const host = "h".repeat(length);
    // This is exactly 63 ASCII bytes, whether the original host fills the field or is truncated by the worker.
    const application = "job-radar ai-worker pid=4242 host=" + "h".repeat(29);
    expect(Buffer.byteLength(application)).toBe(63);
    expect(await workerHolder(connection(application), { pid: 4242, host })).toEqual({ status: "expected" });
    expect(await workerHolder(connection(application), { pid: 4243, host })).toEqual({ status: "other" });
    expect(await workerHolder(connection(application), { pid: 4242, host: "different.invalid" })).toEqual({ status: "other" });
  });

  it("distinguishes absent, other and hidden holders without claiming a parsed host identity", async () => {
    expect(await workerHolder(connection(undefined), expected)).toEqual({ status: "none" });
    expect(await workerHolder(connection("some other application"), expected)).toEqual({ status: "other" });
    expect(await workerHolder(connection(null, false), expected)).toEqual({ status: "unknown", reason: "holder-not-visible" });
  });
});
