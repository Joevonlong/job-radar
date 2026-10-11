import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { loadShellStatus } from "@/lib/shell/status";

// Polled by the sidebar's cycle status; never cached.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await loadShellStatus(getDb()), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "status unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
