// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { SESSION_STATE_UNREADABLE, createMemorySessionStore, createOverlaySessionStore } from "@/lib/channels/linkedin/session/store";

const DAY = "2026-10-07";

describe("session store overlay", () => {
  it("starts each day's counter from the base and keeps increments in memory", async () => {
    const base = createMemorySessionStore({ requests: { [DAY]: 3 } });
    const write = vi.spyOn(base, "addRequest");
    const overlay = createOverlaySessionStore(base);

    expect(await overlay.requestsOn(DAY)).toBe(3);
    expect(await overlay.addRequest(DAY)).toBe(4);
    expect(await overlay.addRequest(DAY)).toBe(5);
    expect(await overlay.requestsOn(DAY)).toBe(5);
    expect(await overlay.addRequest("2026-10-08")).toBe(1);
    expect(await base.requestsOn(DAY)).toBe(3);
    expect(await base.requestsOn("2026-10-08")).toBe(0);
    expect(write).not.toHaveBeenCalled();
  });

  it("reads the base login flag and lets in-memory writes override it without saving", async () => {
    const expired = { status: "expired", reason: "checkpoint", at: "2026-10-07T08:00:00.000Z" } as const;
    const valid = { status: "valid", at: "2026-10-07T09:00:00.000Z" } as const;
    const base = createMemorySessionStore({ flag: expired });
    const write = vi.spyOn(base, "saveAuthFlag");
    const overlay = createOverlaySessionStore(base);

    expect(await overlay.loadAuthFlag()).toEqual(expired);
    await overlay.saveAuthFlag(valid);
    expect(await overlay.loadAuthFlag()).toEqual(valid);
    expect(await base.loadAuthFlag()).toEqual(expired);
    expect(write).not.toHaveBeenCalled();
  });

  it("reads the base recommended timestamp and marks it only in memory", async () => {
    const previous = new Date("2026-10-06T08:00:00.000Z");
    const base = createMemorySessionStore({ recommendedAt: previous });
    const write = vi.spyOn(base, "markRecommended");
    const overlay = createOverlaySessionStore(base);

    expect(await overlay.lastRecommendedAt()).toEqual(previous);
    const before = Date.now();
    await overlay.markRecommended();
    expect((await overlay.lastRecommendedAt())?.getTime()).toBeGreaterThanOrEqual(before);
    expect(await base.lastRecommendedAt()).toEqual(previous);
    expect(write).not.toHaveBeenCalled();
  });

  it("starts empty when the base has no login flag or recommended timestamp and retains local writes", async () => {
    const base = createMemorySessionStore();
    const overlay = createOverlaySessionStore(base);
    expect(await overlay.loadAuthFlag()).toBeNull();
    expect(await overlay.lastRecommendedAt()).toBeNull();

    const expired = { status: "expired", reason: "login_required", at: "2026-10-07T08:00:00.000Z" } as const;
    await overlay.saveAuthFlag(expired);
    await overlay.markRecommended();
    expect(await overlay.loadAuthFlag()).toEqual(expired);
    expect(await overlay.lastRecommendedAt()).toBeInstanceOf(Date);
    expect(await base.loadAuthFlag()).toBeNull();
    expect(await base.lastRecommendedAt()).toBeNull();
  });

  it("reuses payloads read from the base and fills only missing jobs from it", async () => {
    const base = createMemorySessionStore({ payloads: { first: { title: "First" }, second: { title: "Second" } } });
    const read = vi.spyOn(base, "storedPayloads");
    const overlay = createOverlaySessionStore(base);

    expect(await overlay.storedPayloads(["first"])).toEqual(new Map([["first", { title: "First" }]]));
    base.payloads.set("first", { title: "Changed later" });
    expect(await overlay.storedPayloads(["first", "second", "missing"])).toEqual(new Map([
      ["first", { title: "First" }], ["second", { title: "Second" }],
    ]));
    expect(read.mock.calls).toEqual([[["first"]], [["second", "missing"]]]);
    expect(await overlay.storedPayloads([])).toEqual(new Map());
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("re-reads the base page count every time, so pages loaded by a concurrent real run count", async () => {
    const base = createMemorySessionStore({ requests: { [DAY]: 2 } });
    const overlay = createOverlaySessionStore(base);

    expect(await overlay.addRequest(DAY)).toBe(3);
    base.requests.set(DAY, 3);
    expect(await overlay.requestsOn(DAY)).toBe(4);
    expect(await overlay.addRequest(DAY)).toBe(5);
    expect(await base.requestsOn(DAY)).toBe(3);
  });

  it("turns the first failing base read into one ChannelError that stops every later read", async () => {
    const base = createMemorySessionStore();
    const raw = new Error("relation \"runtime_state\" does not exist");
    vi.spyOn(base, "loadAuthFlag").mockRejectedValue(raw);
    const later = vi.spyOn(base, "requestsOn");
    const overlay = createOverlaySessionStore(base);

    const error = await overlay.loadAuthFlag().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "unknown", retryable: false, message: SESSION_STATE_UNREADABLE, cause: raw });
    await expect(overlay.requestsOn(DAY)).rejects.toBe(error);
    await expect(overlay.storedPayloads(["x"])).rejects.toBe(error);
    expect(later).not.toHaveBeenCalled();
  });
});
