import { describe, expect, it } from "vitest";

import { shellStatusSchema } from "@/lib/shell/status-schema";

const base = {
  now: "2026-10-08T07:00:00.000Z",
  state: "idle",
  timezone: "Europe/Berlin",
  next: null,
  cycle: null,
  sources: null,
  runner: { online: true, ageSeconds: 5 },
  aiWorker: { expected: false, online: false, ageSeconds: null },
  progress: null,
};

describe("shell status counts", () => {
  it("reads the favorites count, and treats a response without one (an older server) as 0", () => {
    expect(shellStatusSchema.parse({ ...base, counts: { today: 1, jobs: 2, pipeline: 3, favorites: 4, sourcesAlert: 0 } }).counts.favorites).toBe(4);
    expect(shellStatusSchema.parse({ ...base, counts: { today: 1, jobs: 2, pipeline: 3, sourcesAlert: 0 } }).counts.favorites).toBe(0);
    expect(shellStatusSchema.safeParse({ ...base, counts: { today: 1, jobs: 2, pipeline: 3, favorites: -1, sourcesAlert: 0 } }).success).toBe(false);
  });
});
