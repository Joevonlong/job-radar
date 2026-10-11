import type { NextRequest } from "next/server";

import { handleLogin } from "@/lib/security/login";

// The optional web password (docs/configuration.md "Web access"): a form POST with the password; see handleLogin.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  return handleLogin(request);
}
