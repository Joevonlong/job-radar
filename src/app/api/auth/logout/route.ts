import type { NextRequest } from "next/server";

import { handleLogout } from "@/lib/security/login";

// Signs out: clears the session cookie and goes to the login page. Only reachable with a session (src/proxy.ts).
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleLogout(request);
}
