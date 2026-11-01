// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobsListFilters: vi.fn(async () => ({ marker: "filters" })),
  listUnseenJobIds: vi.fn(async () => [1, 2]),
  markSeenIds: vi.fn(async () => 2),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/dashboard/context", () => ({ getSchedule: () => ({ timezone: "Europe/Berlin" }) }));
vi.mock("@/lib/jobs/list-filters", () => ({ jobsListFilters: mocks.jobsListFilters }));
vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  listUnseenJobIds: mocks.listUnseenJobIds,
  markSeenIds: mocks.markSeenIds,
  markSeen: vi.fn(),
  markUnseen: vi.fn(),
  recordVisit: vi.fn(),
  undoBulkSeen: vi.fn(),
  SEEN_VIAS: ["detail", "source", "action"],
}));

import { markAllSeenAction } from "@/app/visit-actions";

describe("markAllSeenAction: a rolling date range counts back from the moment the page was drawn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    for (const mock of Object.values(mocks)) mock.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("passes the render time as `now` and as the first-seen limit", async () => {
    const renderedAt = "2026-10-20T11:00:00.000Z";
    const result = await markAllSeenAction({ scope: "jobs", query: "within=7d&dateBy=posted", renderedAt });
    expect(result).toMatchObject({ ok: true, count: 2 });
    const [, params, known] = mocks.jobsListFilters.mock.calls[0] as unknown as [unknown, { within: unknown; dateBy: string }, { now: Date }];
    expect(params).toMatchObject({ within: { kind: "days", days: 7 }, dateBy: "posted" });
    expect(known.now.toISOString()).toBe(renderedAt);
    expect(mocks.listUnseenJobIds).toHaveBeenCalledWith({}, expect.objectContaining({ firstSeenUpTo: known.now, timezone: "Europe/Berlin" }));
  });

  it("never lets a render time from the future move the range forward", async () => {
    await markAllSeenAction({ scope: "jobs", query: "within=1d", renderedAt: "2027-01-01T00:00:00.000Z" });
    const [, , known] = mocks.jobsListFilters.mock.calls[0] as unknown as [unknown, unknown, { now: Date }];
    expect(known.now.toISOString()).toBe("2026-10-20T12:00:00.000Z");
  });
});
