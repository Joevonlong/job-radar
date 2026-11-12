import { expect, it } from "vitest";

import { trackingWriteOutput, undoChangeOutput } from "@/lib/mcp/dto";

it("write receipts and undo replies allow only explicit metadata, rejecting row fields and private content", () => {
  const write = { notices: [], audit_id: 1, job_id: 2, field: "next_action", undoable: true, research: null };
  const undo = { notices: [], audit_id: 3, undone_audit_id: 1, field: "next_action", research: null };
  expect(trackingWriteOutput.parse(write)).toEqual(write);
  expect(undoChangeOutput.parse(undo)).toEqual(undo);
  for (const [key, value] of Object.entries({ before_value: "PRIVATE-TEXT-SENTINEL", next_action: "PRIVATE-TEXT-SENTINEL", notesMd: "PRIVATE-TEXT-SENTINEL", caller: "token:1", afterFingerprint: "hash" })) {
    expect(trackingWriteOutput.safeParse({ ...write, [key]: value }).success).toBe(false);
    expect(undoChangeOutput.safeParse({ ...undo, [key]: value }).success).toBe(false);
  }
});
