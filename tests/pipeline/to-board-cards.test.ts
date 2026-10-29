import { createFormatter } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { toBoardCards } from "@/components/pipeline/to-board-cards";
import type { PipelineEntry } from "@/lib/db/queries/pipeline";

vi.mock("next-intl/server", () => ({ getFormatter: async () => createFormatter({ locale: "en", timeZone: "UTC" }) }));
vi.mock("@/components/jobs/to-list-items", () => ({ toListItems: async () => [{}] }));

const now = new Date("2026-07-01T12:00:00Z");
const options = { now, timezone: "Europe/Berlin", thresholds: { interestedDays: 5, appliedDays: 10 } };
function entry(status: PipelineEntry["application"]["status"], appliedAt: Date | null): PipelineEntry {
  return {
    job: {
      id: 1, title: "Observatory engineer", companyId: 1, companyName: "Moonfern", locations: [], workplace: "unknown", contract: "unknown", isAgency: false, germanLevelRequired: "unknown", status: "active", closedReason: null, linkCheck: null,
      postedAt: null, firstSeenAt: now, lastSeenAt: now, lastListedAt: null, salaryDisclosed: false, salary: null, skills: [], sources: [], applicationStatus: status, favorite: null, rank: null, summary: null, signals: [], seen: false,
    },
    application: { id: 1, jobId: 1, status, statusChangedAt: new Date("2026-06-01T23:30:00Z"), nextAction: null, nextActionAt: new Date("2026-06-01T12:00:00Z"), notesMd: null, resumeVariantPath: null, interviewRounds: 0, createdAt: new Date("2020-01-01T12:00:00Z") },
    events: appliedAt ? [{ id: 1, applicationId: 1, fromStatus: null, toStatus: "applied", at: appliedAt, note: null }] : [],
  };
}

describe("server card dates", () => {
  it("uses the display zone at UTC 23:30, while next-action calendar dates stay in UTC", async () => {
    const [card] = await toBoardCards([entry("applied", new Date("2026-06-01T23:30:00Z"))], options);
    expect(card?.appliedDate).toMatchObject({ iso: "2026-06-01T23:30:00.000Z", label: "Jun 2", full: "Jun 2, 2026, 1:30 AM" });
    expect(card?.statusDate).toEqual(card?.appliedDate);
    expect(card?.nextActionDateLabel).toBe("Jun 1");
  });
  it("includes a year only when the event and now are in different display years", async () => {
    const [old] = await toBoardCards([entry("applied", new Date("2025-06-01T12:00:00Z"))], options);
    expect(old?.appliedDate).toMatchObject({ label: "Jun 1, 2025" });
    const [boundary] = await toBoardCards([entry("applied", new Date("2025-12-31T23:30:00Z"))], { ...options, now: new Date("2025-12-31T23:45:00Z") });
    expect(boundary?.appliedDate).toMatchObject({ label: "Jan 1" });
  });
  it("does not substitute creation or status-change times for missing applied events", async () => {
    const [later] = await toBoardCards([entry("interviewing", null)], options);
    expect(later?.appliedDate).toBe("none");
    const [early] = await toBoardCards([entry("interested", null)], options);
    expect(early?.appliedDate).toBeNull();
    const [returned] = await toBoardCards([entry("preparing", new Date("2026-01-01T12:00:00Z"))], options);
    expect(returned?.appliedDate).toMatchObject({ iso: "2026-01-01T12:00:00.000Z" });
  });
});
