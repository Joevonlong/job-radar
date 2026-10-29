// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/repos/runs", () => ({ getQueryRunHistory: vi.fn() }));
import { getQueryRunHistory } from "@/lib/db/repos/runs";
import type { Db } from "@/lib/db";
import { getQueryRotationHistory } from "@/lib/db/queries/sources";

const db = {} as Db;
const read = vi.mocked(getQueryRunHistory);
beforeEach(() => { read.mockReset(); });

describe("query rotation history reads", () => {
  it("starts one independent read per unit in parallel, retaining the full family", async () => {
    let finish: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { finish = resolve; });
    read.mockImplementation(async (_db, { channelIds }) => {
      if (channelIds.includes("linkedin-guest")) await first;
      return [];
    });
    const units = [{ name: "cascade", channelIds: ["linkedin-guest", "linkedin-monid"] }, { name: "indeed", channelIds: ["indeed"] }];
    const result = getQueryRotationHistory(db, { units, queryHashes: ["query"] });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, db, { channelIds: units[0]!.channelIds, queryHashes: ["query"] });
    expect(read).toHaveBeenNthCalledWith(2, db, { channelIds: ["indeed"], queryHashes: ["query"] });
    finish!();
    expect(await result).toEqual(new Map([["cascade", []], ["indeed", []]]));
  });

  it("does not read when there are no units", async () => {
    expect(await getQueryRotationHistory(db, { units: [], queryHashes: ["query"] })).toEqual(new Map());
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a partial history snapshot so the caller can omit status", async () => {
    read.mockRejectedValue(new Error("unavailable"));
    await expect(getQueryRotationHistory(db, { units: [{ name: "indeed", channelIds: ["indeed"] }], queryHashes: ["query"] })).rejects.toThrow("unavailable");
  });
});
