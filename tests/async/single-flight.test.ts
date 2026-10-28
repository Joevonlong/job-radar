// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { singleFlight } from "@/lib/async/single-flight";

describe("singleFlight", () => {
  it("shares a rejection and permits a fresh retry after it settles", async () => {
    const flight = singleFlight<string, number>();
    const first = vi.fn(async () => { throw new Error("try again"); });
    const ignored = vi.fn(async () => 2);
    const a = flight("job:zh", first);
    const b = flight("job:zh", ignored);
    expect(a).toBe(b);
    await expect(a).rejects.toThrow("try again");
    await expect(b).rejects.toThrow("try again");
    expect(first).toHaveBeenCalledTimes(1);
    expect(ignored).not.toHaveBeenCalled();
    expect(await flight("job:zh", ignored)).toBe(2);
  });

  it("different keys run independently and a completed key can run again", async () => {
    const flight = singleFlight<string, number>();
    const run = vi.fn(async () => 1);
    expect(await Promise.all([flight("job:en", run), flight("job:zh", run)])).toEqual([1, 1]);
    expect(run).toHaveBeenCalledTimes(2);
    await flight("job:en", run);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
