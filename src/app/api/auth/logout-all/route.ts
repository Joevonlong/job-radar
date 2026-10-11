import type { NextRequest } from "next/server";

import { handleSignOutEverywhere } from "@/lib/security/login";

// Signs out everywhere: ends every web session (this one too). Only reachable with a session or from this machine (src/proxy.ts).
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleSignOutEverywhere(request);
}
