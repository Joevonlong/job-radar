import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { previewActivityDeleteAction, executeActivityDeleteAction } from "@/app/sources/logs/actions";
import { previewDelete, executeDelete } from "@/lib/activity/manage";
import { logActionFailure } from "@/lib/logging/action-failure";

const { fakeDb } = vi.hoisted(() => ({ fakeDb: {} }));
vi.mock("@/lib/db", () => ({ getDb: () => fakeDb }));
vi.mock("@/lib/activity/manage", () => ({ previewDelete: vi.fn(), executeDelete: vi.fn() }));
vi.mock("@/lib/logging/action-failure", () => ({ logActionFailure: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); });

describe("activity action boundary", () => {
  it("contains service exceptions and returns only a fixed failure code", async () => {
    const error = new Error("SECRET_PAYLOAD");
    vi.mocked(previewDelete).mockRejectedValueOnce(error);
    vi.mocked(executeDelete).mockRejectedValueOnce(error);
    expect(await previewActivityDeleteAction({ scope: "all" })).toEqual({ status: "failed" });
    expect(await executeActivityDeleteAction({ scope: "all" })).toEqual({ status: "failed" });
    expect(logActionFailure).toHaveBeenCalledWith("previewActivityDelete", error);
    expect(logActionFailure).toHaveBeenCalledWith("executeActivityDelete", error);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("revalidates a partial deletion even when the batch removed only child spans", async () => {
    vi.mocked(executeDelete).mockResolvedValueOnce({ status: "partial", roots: 0, events: 0 });
    expect(await executeActivityDeleteAction({ scope: "all" })).toEqual({ status: "partial", roots: 0, events: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/sources/logs");
  });
  it("does not invalidate a completed no-op or an invalid request", async () => {
    vi.mocked(executeDelete).mockResolvedValueOnce({ status: "done", roots: 0, events: 0 }).mockResolvedValueOnce({ status: "invalid" });
    await executeActivityDeleteAction({ scope: "all" });
    await executeActivityDeleteAction({ scope: "all", asOf: "invalid" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
