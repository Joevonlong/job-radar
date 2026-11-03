/**
 * Print a Gmail search for the replies of the current applications (docs/gmail-replies.md). Reads the database only; the mailbox is not touched.
 *
 *   pnpm replies:filter
 */
import { loadConfig } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { listReplyCandidates } from "../src/lib/db/repos/replies";
import { scopeLocale, translatorFor } from "../src/lib/i18n/node";
import { gmailFilterQuery } from "../src/lib/replies/filter-query";

const t = translatorFor(scopeLocale("cli"), "replies.cli");

async function main(): Promise<void> {
  const config = loadConfig("replies");
  const candidates = await listReplyCandidates(getDb(), config.match.candidate_statuses);
  console.log(t("filterIntro", { label: config.label }));
  if (candidates.length === 0) console.log(t("filterEmpty"));
  console.log(gmailFilterQuery({ companies: candidates.map((c) => c.companyName), hosts: candidates.flatMap((c) => c.hosts) }, config.match));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
