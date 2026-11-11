import { expect, it, vi } from "vitest";

vi.mock("@/lib/db/queries/replies", () => ({ listReplyMetadata: vi.fn() }));

import { list_replies } from "@/lib/capabilities/replies/list-replies";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { listReplyMetadata } from "@/lib/db/queries/replies";
import { listRepliesOutput } from "@/lib/mcp/dto";
import { defaultContext } from "@/lib/mcp/server";

it.each(["secret@example.test", "/Users/Fictional/private.txt", "C:\\Fictional\\private.txt"])("cleans %s from both reply metadata fields", async (sentinel) => {
  vi.mocked(listReplyMetadata).mockResolvedValue({ total: 1, rows: [{
    id: 1, receivedAt: new Date("2026-01-01T00:00:00Z"), category: "other", userCategory: null,
    match: "matched", state: "pending", jobId: 1, company: sentinel, title: sentinel, applicationStatus: "applied",
  }] });
  const ctx = defaultContext({} as Db, mcpSchema.parse({}));
  const result = listRepliesOutput.parse(await list_replies.handler(ctx, {}));
  expect(JSON.stringify(result)).not.toContain(sentinel);
  expect(result.replies[0]).toMatchObject({ company: ctx.text("notice.redacted"), title: ctx.text("notice.redacted") });
});
