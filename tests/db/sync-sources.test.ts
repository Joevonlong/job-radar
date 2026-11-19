import { describe, expect, it } from "vitest";

import { get_job } from "@/lib/capabilities/jobs/get-job";
import { get_application } from "@/lib/capabilities/tracking/get-application";
import { list_favorites } from "@/lib/capabilities/tracking/list-favorites";
import { SYNC_BLOCKS, SYNC_KEY_KINDS, SYNC_REMOVED_BITS, SYNC_SOURCES } from "@/lib/db/sync-sources";
import { getJobBlocks } from "@/lib/mcp/job-blocks";
import { applicationDetailNotesBlocks, favoriteNotesBlocks } from "@/lib/mcp/tracking-blocks";

describe("sync dependency matrix", () => {
  it("uses the existing readers' permissions and entity for every block", () => {
    const actual = Object.fromEntries(Object.entries(SYNC_BLOCKS).map(([key, { permission, entity }]) => [key, { permission, entity }]));
    expect(actual).toEqual({
      job: { permission: get_job.permission, entity: "job" },
      ...Object.fromEntries(getJobBlocks.map(({ key, permission }) => [key, { permission, entity: "job" }])),
      app: { permission: get_application.permission, entity: "application" },
      ...Object.fromEntries(applicationDetailNotesBlocks.map(({ key, permission }) => [`app.${key}`, { permission, entity: "application" }])),
      fav: { permission: list_favorites.permission, entity: "favorite" },
      ...Object.fromEntries(favoriteNotesBlocks.map(({ key, permission }) => [`fav.${key}`, { permission, entity: "favorite" }])),
    });
  });

  it("has unique bitmap positions and references only declared blocks and keys", () => {
    const blockBits = Object.values(SYNC_BLOCKS).map(({ bit }) => bit);
    const removedBits = Object.values(SYNC_REMOVED_BITS);
    for (const bits of [blockBits, removedBits]) {
      expect(new Set(bits).size).toBe(bits.length);
      expect(bits.every((bit) => Number.isInteger(bit) && bit >= 0 && bit < 31)).toBe(true);
    }
    for (const source of SYNC_SOURCES) {
      expect(SYNC_KEY_KINDS).toContain(source.key.kind);
      expect(source.blocks.length).toBeGreaterThan(0);
      for (const block of source.blocks) expect(SYNC_BLOCKS).toHaveProperty([block]);
    }
  });
});
