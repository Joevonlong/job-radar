import { expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries/replies", () => ({ listReplyMetadata: vi.fn() }));

import { list_replies } from "@/lib/capabilities/replies/list-replies";
import type { Permission } from "@/lib/agent-access/permissions";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { listReplyMetadata } from "@/lib/db/queries/replies";
import { listRepliesOutput, listRepliesOutputFor } from "@/lib/mcp/dto";
import { defaultContext } from "@/lib/mcp/server";

it.each(["secret@example.test", "/Users/Fictional/private.txt", "C:\\Fictional\\private.txt"])("cleans %s from both reply metadata fields", async (sentinel) => {
  vi.mocked(listReplyMetadata).mockResolvedValue({ total: 1, rows: [{
    id: 1, receivedAt: new Date("2026-01-01T00:00:00Z"), category: "other", userCategory: null,
    match: "matched", state: "pending", jobId: 1, company: sentinel, title: sentinel, applicationStatus: "applied",
  }] });
  const ctx = { ...defaultContext({} as Db, mcpSchema.parse({})), permissions: new Set<Permission>(["replies:read", "tracking:read"]) };
  const result = listRepliesOutput.parse(await list_replies.handler(ctx, {}));
  expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(result.replies[0]).toMatchObject({ company: ctx.text("notice.redacted"), title: ctx.text("notice.redacted") });
});

function rowWithStatus() {
  return { id: 1, receivedAt: new Date("2026-01-01T00:00:00Z"), category: "other" as const, userCategory: null, match: "matched" as const, state: "pending" as const, jobId: 1, company: "Fictional Co", title: "Fictional Role", applicationStatus: "applied" as const };
}

it("leaves the application status out without tracking:read and rejects it in the strict schema", async () => {
  vi.mocked(listReplyMetadata).mockClear();
  vi.mocked(listReplyMetadata).mockResolvedValue({ total: 1, rows: [rowWithStatus()] });
  const permissions = new Set<Permission>(["replies:read"]);
  const ctx = { ...defaultContext({} as Db, mcpSchema.parse({})), permissions };
  const output = listRepliesOutput.parse(await list_replies.handler(ctx, {}));
  expect(vi.mocked(listReplyMetadata).mock.calls[0]?.[1]).toMatchObject({ includeApplicationStatus: false });
  expect(Object.keys(output.replies[0]!)).toEqual(["id", "receivedAt", "category", "match", "state", "jobId", "company", "title"]);
  const schema = listRepliesOutputFor(permissions);
  expect(schema.safeParse(output).success).toBe(true);
  expect(schema.safeParse({ ...output, replies: [{ ...output.replies[0], applicationStatus: "applied" }] }).success).toBe(false);
});

it("returns the application status with tracking:read", async () => {
  vi.mocked(listReplyMetadata).mockClear();
  vi.mocked(listReplyMetadata).mockResolvedValue({ total: 1, rows: [rowWithStatus()] });
  const permissions = new Set<Permission>(["replies:read", "tracking:read"]);
  const ctx = { ...defaultContext({} as Db, mcpSchema.parse({})), permissions };
  const output = listRepliesOutput.parse(await list_replies.handler(ctx, {}));
  expect(vi.mocked(listReplyMetadata).mock.calls[0]?.[1]).toMatchObject({ includeApplicationStatus: true });
  expect(output.replies[0]).toMatchObject({ applicationStatus: "applied" });
  expect(listRepliesOutputFor(permissions).safeParse(output).success).toBe(true);
});
