// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("keeps migration indices contiguous and timestamps strictly increasing", () => {
  const directory = path.resolve(import.meta.dirname, "../../drizzle/meta");
  const journal = JSON.parse(fs.readFileSync(path.join(directory, "_journal.json"), "utf8")) as { entries: { idx: number; when: number }[] };
  journal.entries.forEach((entry, index) => {
    expect(entry.idx).toBe(index);
    if (index > 0) expect(entry.when).toBeGreaterThan(journal.entries[index - 1]!.when);
  });
  const previous = JSON.parse(fs.readFileSync(path.join(directory, "0060_snapshot.json"), "utf8")) as { id: string };
  const current = JSON.parse(fs.readFileSync(path.join(directory, "0061_snapshot.json"), "utf8")) as { prevId: string };
  expect(current.prevId).toBe(previous.id);
});
