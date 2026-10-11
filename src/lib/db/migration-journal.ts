import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

/** What a checkout ships: the number of migrations and the `when` of the newest one. */
export interface MigrationJournal {
  count: number;
  latestAt: number | null;
}

const journalSchema = z.object({ entries: z.array(z.object({ when: z.number() })) });

/** The entries of `<migrations dir>/meta/_journal.json`; null when it cannot be read. */
export async function readJournal(migrationsDir: string): Promise<MigrationJournal | null> {
  try {
    const parsed = journalSchema.parse(JSON.parse(await readFile(path.join(migrationsDir, "meta", "_journal.json"), "utf8")));
    const latest = parsed.entries.reduce<number | null>((max, entry) => (max === null || entry.when > max ? entry.when : max), null);
    return { count: parsed.entries.length, latestAt: latest };
  } catch {
    return null;
  }
}
