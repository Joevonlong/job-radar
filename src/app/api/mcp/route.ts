import { handleMcpHttpRequest, mcpMethodNotAllowed } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function POST(request: Request): Promise<Response> {
  return handleMcpHttpRequest(request);
}

export const GET = mcpMethodNotAllowed;
export const HEAD = mcpMethodNotAllowed;
export const PUT = mcpMethodNotAllowed;
export const PATCH = mcpMethodNotAllowed;
export const DELETE = mcpMethodNotAllowed;
export const OPTIONS = mcpMethodNotAllowed;
