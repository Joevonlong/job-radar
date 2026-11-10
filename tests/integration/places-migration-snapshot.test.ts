import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { parseDocument } from "yaml";

import { preferences003 } from "@/lib/config/migrations/preferences/003-places";
import { stampConfigVersion } from "@/lib/config/migrations/version";
import { closeDb, getDb } from "@/lib/db/client";
import { recordProfileSnapshot, snapshotForProfileText } from "@/lib/profile/snapshots";

const VERSION_2 = `config_version: 2
market: {pack: generic, country: US, currency: USD, home_language: en}
target_titles: [Engineer]
locations: [Boston, Austin]
workplace: [onsite, remote]
remote_scope: {region: [eu]}
seniority: all
salary_floor_year: 70000
contracts: {allow: [permanent], exclude: []}
exclude_student_roles: true
exclude_companies: []
exclude_keywords: []
`;

function migrated(text: string): string {
  const doc = parseDocument(text);
  preferences003.migrate(doc);
  stampConfigVersion(doc, preferences003.to);
  return doc.toString();
}

describe("the places migration and the scores", () => {
  beforeAll(() => {
    process.env.DATABASE_URL = inject("testDatabaseUrl");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("a migrated preferences file keeps its snapshot, so its scores do not go stale", async () => {
    const before = await recordProfileSnapshot(getDb(), "preferences", VERSION_2);
    const after = await snapshotForProfileText(getDb(), "preferences", migrated(VERSION_2));
    expect(after.id).toBe(before.snapshot.id);
  });
});
