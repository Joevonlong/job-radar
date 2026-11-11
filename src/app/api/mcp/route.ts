import { handleMcpHttpRequest } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleMcpHttpRequest(request);
}

export const GET = POST;
export const HEAD = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const OPTIONS = POST;
