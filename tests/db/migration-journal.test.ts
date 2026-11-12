// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps every migration ordered, present and linked to the previous snapshot", () => {
  const directory = path.resolve(import.meta.dirname, "../../drizzle/meta");
  const journal = JSON.parse(fs.readFileSync(path.join(directory, "_journal.json"), "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
  let previousId = "00000000-0000-0000-0000-000000000000";
  journal.entries.forEach((entry, index) => {
    expect(entry.idx, entry.tag).toBe(index);
    if (index > 0) expect(entry.when, entry.tag).toBeGreaterThan(journal.entries[index - 1]!.when);
    expect(fs.existsSync(path.join(directory, "..", `${entry.tag}.sql`)), entry.tag).toBe(true);
    const snapshotPath = path.join(directory, `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
    expect(fs.existsSync(snapshotPath), entry.tag).toBe(true);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { id: string; prevId: string };
    expect(snapshot.prevId, entry.tag).toBe(previousId);
    previousId = snapshot.id;
  });
});
