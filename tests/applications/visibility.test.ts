import { describe, expect, it } from "vitest";

import {
  ALL_APPLICATION_STATUSES,
  boardLayout,
  filterOptions,
  HIDEABLE_STATUSES,
  isStageDrawn,
  isStatusHidden,
  isStatusOffered,
  statusChoices,
} from "@/lib/applications/visibility";
import { APPLICATION_STATUSES } from "@/lib/db/repos/applications";

describe("application status visibility", () => {
  it("lists every status of the database enum, in its order", () => {
    expect([...ALL_APPLICATION_STATUSES]).toEqual([...APPLICATION_STATUSES]);
  });

  it("never hides new or archived", () => {
    expect(HIDEABLE_STATUSES).not.toContain("new");
    expect(HIDEABLE_STATUSES).not.toContain("archived");
    expect(isStatusHidden("new", ["new", "archived"])).toBe(false);
    expect(isStatusHidden("archived", ["archived"])).toBe(false);
    expect(isStatusHidden("preparing", ["preparing"])).toBe(true);
  });

  it("a menu lists the visible statuses, and always the card's own", () => {
    const names = (current: Parameters<typeof statusChoices>[0]) => statusChoices(current, ["preparing", "offer"]).map((c) => c.status);
    expect(names("applied")).not.toContain("preparing");
    expect(names("applied")).toContain("applied");
    expect(names("preparing")).toContain("preparing");
    expect(statusChoices("preparing", ["preparing"]).find((c) => c.status === "preparing")?.hidden).toBe(true);
    expect(statusChoices("new", []).map((c) => c.status)).toEqual([...ALL_APPLICATION_STATUSES]);
  });

  it("does not offer a hidden target to shortcuts", () => {
    expect(isStatusOffered("interested", ["interested"])).toBe(false);
    expect(isStatusOffered("archived", ["interested"])).toBe(true);
  });

  it("board columns: shown, collapsed (hidden with cards) or gone (hidden without)", () => {
    const layout = boardLayout(["preparing", "interviewing", "rejected"], { interviewing: 2, rejected: 1, archived: 3, applied: 4 });
    const mode = (column: string) => layout.columns.find((c) => c.column === column);
    expect(mode("preparing")?.mode).toBe("none");
    expect(mode("interviewing")).toMatchObject({ mode: "collapsed", count: 2 });
    expect(mode("applied")?.mode).toBe("shown");
    expect(mode("ended")).toMatchObject({ mode: "shown", count: 4 });
    expect(layout.endedZones).toEqual(["withdrawn", "archived"]);
    expect(layout.endedHiddenWithCards).toEqual(["rejected"]);
    expect(layout.hiddenCards).toBe(3);
  });

  it("filters list the visible values but keep a selected hidden one", () => {
    const all = ["onsite", "hybrid", "remote"] as const;
    expect(filterOptions(all, ["onsite"], [])).toEqual(["hybrid", "remote"]);
    expect(filterOptions(all, ["onsite"], ["onsite"])).toEqual([...all]);
  });

  it("a funnel stage is drawn unless hidden and empty", () => {
    expect(isStageDrawn("preparing", ["preparing"], 0)).toBe(false);
    expect(isStageDrawn("preparing", ["preparing"], 2)).toBe(true);
    expect(isStageDrawn("applied", ["preparing"], 0)).toBe(true);
  });
});
