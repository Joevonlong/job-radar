/**
 * Prints the Telegram preview of one demo job as JSON (`{ message, html }`) for e2e-demo/shots.spec.ts. Runs under tsx
 * (the app's modules import JSON message catalogs, which Playwright's loader does not take).
 *
 *   DATABASE_URL=<demo database> JOB_RADAR_CONFIG_DIR=... JOB_RADAR_PROFILE_DIR=... tsx e2e-demo/telegram-render.ts <job id>
 */
import { demoDbNameOf } from "../scripts/demo/checks";
import { createConnection } from "../src/lib/db/client";
import { getPushCandidate } from "../src/lib/db/repos/notifications";
import { notifyText } from "../src/lib/notify/text";

import { renderTelegramPreview } from "./telegram-preview";

const url = process.env.DATABASE_URL ?? "";
demoDbNameOf(url);
const jobId = Number(process.argv[2]);
if (!Number.isInteger(jobId)) throw new Error("usage: telegram-render.ts <job id>");

const connection = createConnection(url, { max: 1 });
try {
  const candidate = await getPushCandidate(connection.db, jobId);
  if (!candidate) throw new Error(`job ${jobId} has no push candidate`);
  const preview = renderTelegramPreview({ candidate, watched: false, rank: candidate.score?.rankValue ?? null, reason: "threshold" }, notifyText("en"), {
    caption: "Message format preview (demo data)",
    botName: "Job Radar",
    time: "10:00",
  });
  process.stdout.write(JSON.stringify(preview));
} finally {
  await connection.sql.end({ timeout: 5 });
}
