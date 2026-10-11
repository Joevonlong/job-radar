import path from "node:path";

import { describe, expect, it } from "vitest";

import { diskLevel, internalDataPath, measureDisk, resolveDiskStatus, sameVolume, volumeLabel } from "@/lib/ops/disk";

const GB = 1024 ** 3;
const thresholds = { min_free_disk_gb: 5, warn_free_disk_gb: 20 };

describe("diskLevel", () => {
  it("fails under the minimum, warns under the warning line, otherwise ok (same thresholds as doctor)", () => {
    expect(diskLevel(4 * GB, thresholds)).toBe("fail");
    expect(diskLevel(15.8 * GB, thresholds)).toBe("warn");
    expect(diskLevel(40 * GB, thresholds)).toBe("ok");
    expect(diskLevel(5 * GB, thresholds)).toBe("warn");
    expect(diskLevel(20 * GB, thresholds)).toBe("ok");
  });
});

const now = new Date("2026-10-07T12:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const local = { freeBytes: 42 * GB, totalBytes: 100 * GB };
const hostRecord = (freeGb: number, ageMinutes: number) => ({ diskFreeBytes: freeGb * GB, diskTotalBytes: 460 * GB, diskPath: "/Users/me", measuredAt: minutesAgo(ageMinutes) });

describe("resolveDiskStatus", () => {
  it("prefers a recent host measurement over the container's own", () => {
    const status = resolveDiskStatus({ host: hostRecord(14, 5), local, now, checkMinutes: 10, thresholds });
    expect(status).toMatchObject({ level: "warn", source: "host", path: "/Users/me", percent: 3 });
  });

  it("falls back to the local measurement when the host value is missing or stale", () => {
    for (const host of [null, hostRecord(14, 31)]) {
      expect(resolveDiskStatus({ host, local, now, checkMinutes: 10, thresholds })).toMatchObject({ level: "ok", source: "local", path: null });
    }
  });

  it("is null when nothing can be measured", () => {
    expect(resolveDiskStatus({ host: null, local: null, now, checkMinutes: 10, thresholds })).toBeNull();
  });
});

describe("measureDisk", () => {
  it("measures the nearest existing parent of a missing path", async () => {
    const space = await measureDisk("/definitely/not/here");
    expect(space?.totalBytes).toBeGreaterThan(0);
  });
});

describe("sameVolume, volumeLabel, internalDataPath", () => {
  it("compares the device of two paths (missing ones at their nearest existing parent)", async () => {
    const here = import.meta.dirname;
    expect(await sameVolume(here, path.join(here, "not", "there"))).toBe(true);
    expect(await sameVolume(here, here)).toBe(true);
  });

  it("names an external volume by its mount point, anything else by the path itself", () => {
    expect(volumeLabel("/Volumes/Data/projects/job-radar")).toBe("/Volumes/Data");
    expect(volumeLabel("/Volumes/Data/.docker-data")).toBe("/Volumes/Data");
    expect(volumeLabel("/Users/me/job-radar")).toBe("/Users/me/job-radar");
  });

  it("measures the system data volume on macOS and / elsewhere", () => {
    expect(internalDataPath("darwin")).toBe("/System/Volumes/Data");
    expect(internalDataPath("linux")).toBe("/");
  });
});
