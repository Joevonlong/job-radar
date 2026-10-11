import postgres from "postgres";

import runnerSetup from "../e2e/global-setup";

import { loadPrivateStrings } from "./guard";
import { REPO_ROOT, REQUIRE_PATTERNS } from "./helpers";

/** Heartbeat interval of the stand-in AI worker (the pages show a worker without a recent beat as down). */
const AI_WORKER_BEAT_MS = 2000;

/**
 * The demo instance looks like a healthy installation: the e2e stand-in runner (heartbeat, config acknowledgement,
 * control requests) and a heartbeat for the host AI worker. No AI is called.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // the guard's private patterns: checked (and counted, never printed) before any page is opened
  const { strings } = loadPrivateStrings(REPO_ROOT, { require: REQUIRE_PATTERNS });
  console.log(`leak guard: ${strings.length} private pattern(s) loaded${REQUIRE_PATTERNS ? " (required)" : ""}`);
  const stopRunner = await runnerSetup();
  const sql = postgres(process.env.E2E_DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
  const beat = () => sql`insert into runner_heartbeats (process) values ('ai-worker')`.then(() => undefined, () => undefined);
  await beat();
  const timer = setInterval(() => void beat(), AI_WORKER_BEAT_MS);
  return async () => {
    clearInterval(timer);
    await sql.end({ timeout: 5 });
    await stopRunner();
  };
}
