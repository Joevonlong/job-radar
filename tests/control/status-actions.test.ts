// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { translateStatusAction } from "@/app/jobs/[id]/actions";
import { breakdownStatusAction } from "@/app/jobs/[id]/breakdown-actions";
import { salaryLookupStatusAction } from "@/app/jobs/[id]/salary-actions";

const { readTranslation, readBreakdown, readLookup } = vi.hoisted(() => ({ readTranslation: vi.fn(), readBreakdown: vi.fn(), readLookup: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/db")>()), getDb: vi.fn() }));
vi.mock("@/lib/control/translate-request", () => ({ readTranslateRequest: readTranslation, requestTranslateJob: vi.fn() }));
vi.mock("@/lib/control/breakdown-request", () => ({ readBreakdownRequest: readBreakdown, requestBreakdownJob: vi.fn() }));
vi.mock("@/lib/control/salary-request", () => ({ readSalaryLookupRequest: readLookup, requestSalaryLookup: vi.fn() }));
vi.mock("@/lib/control/service", () => ({ requestScoreJobs: vi.fn() }));
vi.mock("@/lib/salary/settings", () => ({ readSalarySettings: () => ({ state: "error", problem: "test settings unavailable" }) }));

beforeEach(() => vi.resetAllMocks());

describe.each([
  { name: "translation", action: translateStatusAction, read: readTranslation },
  { name: "breakdown", action: breakdownStatusAction, read: readBreakdown },
  { name: "salary lookup", action: salaryLookupStatusAction, read: readLookup },
])("$name status action", ({ action, read }) => {
  it("returns an unknown read after a transient error, then reads the request again", async () => {
    read.mockRejectedValueOnce(new Error("temporary read failure")).mockResolvedValueOnce({ state: "waiting", stage: "pending", partial: null, queue: null });
    expect(await action({ jobId: 7, requestId: 41 })).toBeNull();
    expect(await action({ jobId: 7, requestId: 41 })).toMatchObject({ ok: true, state: "waiting", stage: "pending", queue: null });
  });

  it("preserves a real terminal failure even when its error code is generic", async () => {
    read.mockResolvedValueOnce({ state: "failed", error: "failed", detail: null, partial: null, resumeAt: null });
    expect(await action({ jobId: 7, requestId: 41 })).toMatchObject({ ok: false, error: "failed" });
  });

  it("preserves a missing request as a terminal result", async () => {
    read.mockResolvedValueOnce({ state: "missing" });
    expect(await action({ jobId: 7, requestId: 41 })).toEqual({ ok: false, error: "not_found" });
  });
});
