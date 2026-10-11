import { getDb, pingDb, readLatestHeartbeatAt } from "@/lib/db";
import { shapeHealth } from "@/lib/health";

// Always evaluated per request: the answer is the live state of db and runner.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let dbOk = false;
  let lastHeartbeatAt: Date | null = null;

  try {
    const db = getDb();
    dbOk = await pingDb(db);
    if (dbOk) lastHeartbeatAt = await readLatestHeartbeatAt(db);
  } catch (error) {
    // Only the error class is logged: messages can embed connection details (C4).
    console.error("[health] database unavailable:", error instanceof Error ? error.name : "unknown error");
  }

  const { status, body } = shapeHealth({ dbOk, lastHeartbeatAt, now: new Date() });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
