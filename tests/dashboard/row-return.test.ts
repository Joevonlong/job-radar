import { afterEach, describe, expect, it, vi } from "vitest";

import { rememberOpenedRow, takeReturnedRow } from "@/lib/dashboard/row-return";

afterEach(() => {
  window.sessionStorage.clear();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("row-return: back from a job lands on the row that was opened", () => {
  it("hands the job id back once, for the same list URL", () => {
    window.history.replaceState(null, "", "/jobs?q=engineer");
    rememberOpenedRow(42);
    expect(takeReturnedRow()).toBe(42);
    expect(takeReturnedRow()).toBeNull();
  });

  it("does not hand it to another list URL, and forgets a row that is too old", () => {
    window.history.replaceState(null, "", "/jobs");
    rememberOpenedRow(7);
    window.history.replaceState(null, "", "/");
    expect(takeReturnedRow()).toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T08:00:00Z"));
    rememberOpenedRow(8);
    vi.setSystemTime(new Date("2026-10-08T09:00:00Z"));
    expect(takeReturnedRow()).toBeNull();
  });
});
