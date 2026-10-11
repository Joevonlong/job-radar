// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  configArchiveName,
  formatBackupName,
  formatManualBackupName,
  isoWeekKey,
  orphanConfigArchives,
  parseBackupName,
  planRetention,
  planSystemRetention,
  systemBackupLabel,
} from "@/lib/ops/retention";

const BERLIN = "Europe/Berlin";

/** Backup name for a local day at 03:30, like the runner's schedule produces. */
function nightly(year: number, month: number, day: number, time = "033000"): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `jobradar-${year}${pad(month)}${pad(day)}-${time}.dump`;
}

/** `count` consecutive nightly backups ending on 2026-10-07 (newest last). */
function nightlyRun(count: number): string[] {
  const names: string[] = [];
  const end = Date.UTC(2026, 9, 7);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(end - i * 86_400_000);
    names.push(nightly(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }
  return names;
}

describe("isoWeekKey", () => {
  it("follows ISO 8601 around year boundaries", () => {
    expect(isoWeekKey(2026, 1, 1)).toBe("2026-W01"); // Thursday
    expect(isoWeekKey(2021, 1, 3)).toBe("2020-W53"); // Sunday before the first Monday
    expect(isoWeekKey(2024, 12, 30)).toBe("2025-W01"); // Monday of the week with 2025-01-02
    expect(isoWeekKey(2026, 10, 5)).toBe("2026-W41"); // Monday
    expect(isoWeekKey(2026, 10, 11)).toBe("2026-W41"); // Sunday of the same week
    expect(isoWeekKey(2026, 10, 12)).toBe("2026-W42");
  });
});

describe("parseBackupName", () => {
  it("reads day, week and stamp from a scheduled backup name", () => {
    expect(parseBackupName("jobradar-20261007-033000.dump")).toEqual({
      name: "jobradar-20261007-033000.dump",
      day: "2026-10-07",
      week: "2026-W41",
      stamp: "20261007033000",
    });
  });

  it("rejects everything that is not a scheduled backup", () => {
    for (const name of [
      "jobradar-manual-20261007-033000.dump",
      "jobradar-20261007-033000.dump.partial",
      "jobradar-20261007-0330.dump",
      "jobradar-20261340-033000.dump",
      "jobradar-20260230-033000.dump",
      "jobradar-20261007-250000.dump",
      "notes.txt",
      "",
    ]) {
      expect(parseBackupName(name), name).toBeNull();
    }
  });
});

describe("formatBackupName", () => {
  it("uses the wall clock of the schedule's time zone", () => {
    expect(formatBackupName(new Date("2026-10-07T01:30:00Z"), BERLIN)).toBe("jobradar-20261007-033000.dump"); // CEST, +2
    expect(formatBackupName(new Date("2026-12-07T02:30:00Z"), BERLIN)).toBe("jobradar-20261207-033000.dump"); // CET, +1
  });

  it("crosses the date line with the zone, and never prints hour 24", () => {
    expect(formatBackupName(new Date("2026-10-07T22:00:05Z"), BERLIN)).toBe("jobradar-20261008-000005.dump");
    expect(formatBackupName(new Date("2026-10-07T22:00:05Z"), "UTC")).toBe("jobradar-20261007-220005.dump");
  });

  it("round-trips through parseBackupName", () => {
    const name = formatBackupName(new Date("2026-03-29T01:30:00Z"), BERLIN); // right after the spring DST jump
    expect(parseBackupName(name)?.name).toBe(name);
  });
});

describe("planRetention", () => {
  it("keeps the newest backup of each of the last 14 days and of the last 8 weeks, and removes the rest", () => {
    const names = nightlyRun(100);
    const plan = planRetention(names, { keepDaily: 14, keepWeekly: 8 });

    const last14 = names.slice(-14);
    for (const name of last14) expect(plan.keep).toContain(name);

    // the newest backup of each older week: Sundays here (the run ends on a Wednesday, 2026-W41)
    const weekly = plan.keep.filter((name) => !last14.includes(name));
    expect(weekly).toHaveLength(5); // weeks 41, 40 and 39 are already covered by the dailies: 8 weeks - 3
    for (const name of weekly) expect(parseBackupName(name)?.day).toMatch(/^2026-(0[89])-/);
    expect(weekly.map((name) => new Date(`${parseBackupName(name)?.day}T00:00:00Z`).getUTCDay())).toEqual(Array(5).fill(0));

    expect(plan.keep.length + plan.remove.length).toBe(100);
    expect(plan.keep).toHaveLength(19);
    expect(new Set([...plan.keep, ...plan.remove]).size).toBe(100);
  });

  it("is deterministic and lists newest first", () => {
    const names = nightlyRun(30);
    const shuffled = [...names].reverse();
    expect(planRetention(shuffled, { keepDaily: 3, keepWeekly: 0 })).toEqual({
      keep: [nightly(2026, 10, 7), nightly(2026, 10, 6), nightly(2026, 10, 5)],
      remove: names.slice(0, 27).reverse(),
    });
  });

  it("keeps only the newest backup of a day", () => {
    const names = [nightly(2026, 10, 7, "033000"), nightly(2026, 10, 7, "143000"), nightly(2026, 10, 6, "033000")];
    expect(planRetention(names, { keepDaily: 5, keepWeekly: 0 })).toEqual({
      keep: [nightly(2026, 10, 7, "143000"), nightly(2026, 10, 6, "033000")],
      remove: [nightly(2026, 10, 7, "033000")],
    });
  });

  it("counts days that have a backup, so a long outage does not delete the history", () => {
    const names = [nightly(2026, 6, 1), nightly(2026, 6, 2), nightly(2026, 10, 7)];
    const plan = planRetention(names, { keepDaily: 14, keepWeekly: 8 });
    expect(plan.remove).toEqual([]);
    expect(plan.keep).toEqual([nightly(2026, 10, 7), nightly(2026, 6, 2), nightly(2026, 6, 1)]);
  });

  it("with keepWeekly 0 it keeps only the daily set", () => {
    const names = nightlyRun(40);
    expect(planRetention(names, { keepDaily: 14, keepWeekly: 0 }).keep).toHaveLength(14);
  });

  it("with keepWeekly above keepDaily's reach it keeps one backup per week beyond the dailies", () => {
    const names = nightlyRun(200);
    const plan = planRetention(names, { keepDaily: 1, keepWeekly: 4 });
    expect(plan.keep).toHaveLength(4);
    expect(plan.keep[0]).toBe(nightly(2026, 10, 7));
  });

  it("never touches names that are not scheduled backups", () => {
    const plan = planRetention(["jobradar-manual-20250101-000000.dump", "README.txt", "jobradar-20261007-033000.dump.partial"], {
      keepDaily: 1,
      keepWeekly: 1,
    });
    expect(plan).toEqual({ keep: [], remove: [] });
  });

  it("handles an empty directory", () => {
    expect(planRetention([], { keepDaily: 14, keepWeekly: 8 })).toEqual({ keep: [], remove: [] });
  });
});

describe("manual and system backup names", () => {
  it("formats the manual name the scripts use and the config archive name next to a dump", () => {
    expect(formatManualBackupName(new Date("2026-10-07T01:30:00Z"), BERLIN, "premigrate-3-5")).toBe("jobradar-manual-20261007-033000-premigrate-3-5.dump");
    expect(configArchiveName("jobradar-20261007-033000.dump")).toBe("jobradar-20261007-033000.config.tgz");
    expect(configArchiveName("jobradar-manual-20261007-033000-pre-deploy.dump")).toBe("jobradar-manual-20261007-033000-pre-deploy.config.tgz");
  });

  it("finds scheduled config archives without a dump", () => {
    expect(
      orphanConfigArchives([
        "jobradar-20261007-033000.dump",
        "jobradar-20261007-033000.config.tgz",
        "jobradar-20261001-033000.config.tgz",
        "jobradar-manual-20261001-033000.config.tgz",
      ]),
    ).toEqual(["jobradar-20261001-033000.config.tgz"]);
  });

  it("recognises only the safety labels", () => {
    expect(systemBackupLabel("jobradar-manual-20261007-033000-pre-deploy.dump")).toBe("pre-deploy");
    expect(systemBackupLabel("jobradar-manual-20261007-033000-pre-restore.dump")).toBe("pre-restore");
    expect(systemBackupLabel("jobradar-manual-20261007-033000-premigrate-3-5.dump")).toBe("premigrate");
    expect(systemBackupLabel("jobradar-manual-20261007-033000-pre-deployment.dump")).toBeNull();
    expect(systemBackupLabel("jobradar-manual-20261007-033000.dump")).toBeNull();
    expect(systemBackupLabel("jobradar-manual-20261007-033000-mine.dump")).toBeNull();
    expect(systemBackupLabel("jobradar-20261007-033000.dump")).toBeNull();
  });
});

describe("planSystemRetention", () => {
  const stamp = (day: number) => `202610${String(day).padStart(2, "0")}-010000`;
  it("keeps the newest N of each kind by the stamp in the name and removes the rest", () => {
    const names = [
      ...[1, 2, 3, 4, 5, 6, 7].map((d) => `jobradar-manual-${stamp(d)}-premigrate-${d}-${d + 1}.dump`),
      ...[1, 2, 3].map((d) => `jobradar-manual-${stamp(d)}-pre-deploy.dump`),
      `jobradar-manual-${stamp(1)}-pre-restore.dump`,
    ];
    const plan = planSystemRetention(names, 5);
    expect(plan.remove.sort()).toEqual([`jobradar-manual-${stamp(1)}-premigrate-1-2.dump`, `jobradar-manual-${stamp(2)}-premigrate-2-3.dump`]);
    expect(plan.keep).toHaveLength(names.length - 2);
  });

  it("never lists unlabeled, user-labelled, scheduled or non-dump files", () => {
    const names = [
      `jobradar-manual-${stamp(1)}.dump`,
      `jobradar-manual-${stamp(1)}-mine.dump`,
      `jobradar-${stamp(1)}.dump`,
      `jobradar-manual-${stamp(1)}-pre-deploy.config.tgz`,
      "notes.txt",
    ];
    expect(planSystemRetention(names, 0)).toEqual({ keep: [], remove: [] });
  });

  it("keep 0 removes every safety backup", () => {
    expect(planSystemRetention([`jobradar-manual-${stamp(1)}-pre-deploy.dump`], 0).remove).toEqual([`jobradar-manual-${stamp(1)}-pre-deploy.dump`]);
  });
});
