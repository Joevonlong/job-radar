/**
 * Try the Gmail reply rules (docs/gmail-replies.md).
 *
 *   pnpm replies:check [--write] [--json] [--eml FILE]
 *
 * Reads the label of replies.yaml read-only and prints counts and categories only: no subject, sender or body. Nothing is stored
 * unless `--write` is given, and `--write` is refused while replies.yaml has `enabled: false`. `--eml FILE` classifies one local
 * message and needs neither a mailbox nor a database. Argument handling and printing live here; the logic is `src/lib/replies`.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createLogger } from "../src/lib/channels/logger";
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { scopeLocale, translatorFor } from "../src/lib/i18n/node";
import { loadPipeline } from "../src/lib/market";
import { classifyEml, mailboxCredentials, readReplies } from "../src/lib/replies/step";

const t = translatorFor(scopeLocale("cli"), "replies.cli");

const listOf = (counts: Partial<Record<string, number>>): string =>
  Object.entries(counts)
    .map(([name, count]) => `${name} ${count}`)
    .join(", ") || "-";

async function checkFile(file: string, json: boolean): Promise<number> {
  const row = await classifyEml(readFileSync(file), loadConfig("replies"));
  if (json) console.log(JSON.stringify({ category: row.category, suspiciousInstruction: row.suspiciousInstruction }));
  else {
    console.log(t("emlCategory", { category: row.category }));
    console.log(t("emlSuspicious", { value: String(row.suspiciousInstruction) }));
  }
  return 0;
}

async function checkMailbox(write: boolean, json: boolean): Promise<number> {
  const config = loadConfig("replies");
  if (write && !config.enabled) {
    console.error(t("writeOff"));
    return 1;
  }
  if (!mailboxCredentials()) {
    console.error(t("noCredentials"));
    return 1;
  }
  const quiet = createLogger({ minLevel: "warn" });
  try {
    const result = await readReplies({
      config,
      gmail: loadConfig("channels").sources.gmail,
      db: getDb(),
      write,
      legalSuffixes: loadPipeline().company.legal_suffixes,
      logger: quiet,
      signal: AbortSignal.timeout(5 * 60_000),
      now: () => new Date(),
    });
    if (json) console.log(JSON.stringify({ ...result, written: write }));
    else {
      console.log(t("summary", { fresh: result.fresh, read: result.read, stored: result.stored }));
      console.log(t("categories", { list: listOf(result.categories) }));
      console.log(t("matches", { list: listOf(result.matches) }));
      if (!write) console.log(t("preview"));
    }
    return 0;
  } catch (error) {
    console.error(t("failed", { message: error instanceof Error ? error.message : "unexpected error" }));
    return 1;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { write: { type: "boolean", default: false }, json: { type: "boolean", default: false }, eml: { type: "string" } }, allowPositionals: false });
  return values.eml ? checkFile(values.eml, values.json) : checkMailbox(values.write, values.json);
}

main()
  .then(async (code) => {
    await closeDb();
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    await closeDb();
    process.exitCode = 1;
  });
