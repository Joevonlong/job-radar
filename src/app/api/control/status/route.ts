import { NextResponse } from "next/server";

import { getDb } from "@/lib/db";
import { loadControlStatus } from "@/lib/settings/status";

// Polled by the settings page while a request or a config reload is pending; never cached.
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await loadControlStatus(getDb()), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "status unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
