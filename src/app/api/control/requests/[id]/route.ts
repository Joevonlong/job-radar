import { NextResponse } from "next/server";

import { loadControlRequestView } from "@/lib/control/request-view";
import { getDb } from "@/lib/db";

// Polled by the trigger buttons of /sources and /settings while their request is open; never cached.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id: raw } = await params;
  const id = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "bad id" }, { status: 400, headers: NO_STORE });
  try {
    const view = await loadControlRequestView(getDb(), id);
    if (view === null) return NextResponse.json({ error: "not found" }, { status: 404, headers: NO_STORE });
    return NextResponse.json(view, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "status unavailable" }, { status: 503, headers: NO_STORE });
  }
}
