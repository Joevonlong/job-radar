import { describe, expect, it } from "vitest";

import { boardSalaryOf } from "@/components/pipeline/salary";
import { eventKindOf, timelineLines, type TimelineLabels } from "@/components/pipeline/timeline-lines";
import type { BoardEvent } from "@/components/pipeline/types";
import type { JobSalary } from "@/lib/domain/types";
import { asSalary } from "./helpers/salary";

const labels: TimelineLabels = {
  status: (s) => `[${s}]`,
  created: (to) => `created ${to}`,
  moved: (from, to) => `${from} -> ${to}`,
  stayed: (to) => `still ${to}`,
  note: (text) => `note: ${text}`,
  occurredAt: (date) => `Applied on ${date}`,
  reference: (reference) => `Reference ${reference}`,
  generic: (kind) => `event (${kind})`,
};

const event = (id: number, from: BoardEvent["from"], to: BoardEvent["to"], note: string | null = null): BoardEvent =>
  ({ id, when: "Oct 8", from, to, note, occurredAt: null, reference: null });

describe("timelineLines", () => {
  it("says what happened on every line, oldest first, the newest amber", () => {
    const lines = timelineLines([event(3, "interested", "preparing", "CV in progress"), event(2, "new", "interested"), event(1, null, "new")], labels);
    expect(lines.map((l) => l.text)).toEqual(["created [new]", "[new] -> [interested]", "[interested] -> [preparing]", "note: CV in progress"]);
    expect(lines.find((l) => l.text === "[interested] -> [preparing]")?.tone).toBe("amber");
    expect(lines.every((l) => l.text.trim() !== "")).toBe(true);
  });

  it("names every kind, and a kind it does not know is a generic line with the raw kind, never blank", () => {
    expect(eventKindOf(event(1, null, "new"))).toBe("created");
    expect(eventKindOf(event(1, "new", "applied"))).toBe("moved");
    expect(eventKindOf(event(1, "applied", "applied"))).toBe("stayed");
    const broken = { ...event(9, null, "new", "  "), to: undefined as unknown as BoardEvent["to"] };
    const lines = timelineLines([broken, event(2, "applied", "applied", "x")], labels);
    expect(lines.map((l) => l.text)).toEqual(["still [applied]", "note: x", "event (unknown)"]);
    for (const line of lines) expect(line.text.trim()).not.toBe("");
  });

  it.each([
    { occurredAt: "Oct 1", reference: null, detail: "Applied on Oct 1" },
    { occurredAt: null, reference: "receipt-17", detail: "Reference receipt-17" },
    { occurredAt: "Oct 1", reference: "receipt-17", detail: "Applied on Oct 1 · Reference receipt-17" },
  ])("adds one dim detail line for $detail without moving the event", ({ occurredAt, reference, detail }) => {
    const applied = { ...event(2, "interested", "applied", "Sent CV"), occurredAt, reference };
    expect(timelineLines([applied, event(1, null, "interested")], labels)).toEqual([
      { prefix: "Oct 8", text: "created [interested]", tone: "ink" },
      { prefix: "Oct 8", text: "[interested] -> [applied]", tone: "amber" },
      { text: detail, tone: "dim", wrap: true },
      { text: "note: Sent CV", tone: "dim" },
    ]);
  });

  it("has no lines for no events", () => {
    expect(timelineLines([], labels)).toEqual([]);
  });
});

const salary = (over: Partial<JobSalary>): JobSalary => asSalary({
  raw: "x",
  currency: "EUR",
  period: "year",
  min: null,
  max: null,
  perYear: null,
  eurPerYear: null,
  periodAssumed: false,
  origin: "channel",
  qualityStatus: "valid",
  reasonCodes: [],
  ...over,
});

describe("boardSalaryOf", () => {
  it("takes the EUR per-year range, marks converted currencies approximate, and carries the other-region flag", () => {
    expect(boardSalaryOf(salary({ eurPerYear: { min: 85_000, max: 105_000 } }))).toEqual({ min: 85_000, max: 105_000, currency: "EUR", approx: false, otherRegion: false });
    expect(boardSalaryOf(salary({ currency: "USD", eurPerYear: { min: 129_000, max: 156_000 }, otherRegion: "currency" }))).toEqual({ min: 129_000, max: 156_000, currency: "EUR", approx: true, otherRegion: true });
  });

  it("falls back to the posting's own currency, and shows nothing for no figures or a salary under review", () => {
    expect(boardSalaryOf(salary({ currency: "GBP", perYear: { min: 60_000, max: 70_000 } }))).toMatchObject({ currency: "GBP", approx: false });
    expect(boardSalaryOf(salary({}))).toBeNull();
    expect(boardSalaryOf(salary({ eurPerYear: { min: 1, max: 2 }, qualityStatus: "review" }))).toBeNull();
    expect(boardSalaryOf(null)).toBeNull();
  });
});
