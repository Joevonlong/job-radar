// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { SYNC_BLOCKS, SYNC_DTO_VERSION } from "@/lib/db/sync-sources";
import { listJobChangesOutput } from "@/lib/mcp/dto/sync";
import { getJobBlocks } from "@/lib/mcp/job-blocks";
import { mcpTranslator } from "@/lib/mcp/text";

it("pins the job sync JSON Schema digest to its DTO version", () => {
  const schemaByVersion: Record<number, string> = {
    1: "d85e7f79efcb230e6f0c7ac8b7f86b3150f1bb4a7cb77f77588fcc75b682be93",
  };
  const schema = JSON.stringify(listJobChangesOutput.toJSONSchema());
  expect(createHash("sha256").update(schema).digest("hex")).toBe(schemaByVersion[SYNC_DTO_VERSION]);
});

it("uses the same block permissions as get_job", () => {
  for (const block of getJobBlocks) {
    expect(SYNC_BLOCKS[block.key]).toMatchObject({ permission: block.permission, entity: "job" });
  }
});

it.each(["en", "zh"] as const)("keeps all sync error tokens in the %s catalog", (locale) => {
  const text = mcpTranslator(locale);
  expect(text("sync.errors.invalidCursor")).toMatch(/^invalid_cursor:/);
  expect(text("sync.errors.unavailable")).toMatch(/^sync_unavailable:/);
  expect(text("sync.errors.pruned")).toMatch(/^resync_required \(pruned\):/);
  expect(text("sync.errors.logReset")).toMatch(/^resync_required \(log_reset\):/);
  expect(text("sync.errors.scopeChanged")).toMatch(/^resync_required \(scope_changed\):/);
});
