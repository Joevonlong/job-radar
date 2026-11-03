import { describe, expect, it } from "vitest";

import { repliesCheck } from "@/lib/ops/doctor/checks/data";
import type { RepliesProbe } from "@/lib/ops/doctor/types";

import { makeContext, only } from "./helpers";

const on = (over: Partial<Extract<RepliesProbe, { state: "ok" }>> = {}): RepliesProbe => ({ state: "ok", enabled: true, label: "JobReplies", credentials: true, lastReadAt: new Date(), pending: 2, stalePending: 0, warnDays: 7, ...over });
const check = (probe: RepliesProbe) => only(repliesCheck, makeContext({ probes: { replies: async () => probe } }));

describe("data.replies", () => {
  it("off is the default and fine", async () => {
    const result = await only(repliesCheck, makeContext());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("enabled: false");
  });

  it("on and healthy names the label and what waits", async () => {
    const result = await check(on());
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("JobReplies");
  });

  it("warns when the credentials are missing, the label was never read, or replies wait too long", async () => {
    expect((await check(on({ credentials: false }))).status).toBe("warn");
    expect((await check(on({ lastReadAt: null }))).status).toBe("warn");
    const stale = await check(on({ stalePending: 3 }));
    expect(stale.status).toBe("warn");
    expect(stale.detail).toContain("3");
  });

  it("a bad file is a warning, not a crash", async () => {
    expect((await check({ state: "config_error", problem: "label: Required" })).status).toBe("warn");
  });
});
