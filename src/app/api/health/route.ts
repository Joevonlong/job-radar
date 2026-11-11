/** Health is evaluated per request because it reports the live database and runner state. */
import { loadHealth } from "@/lib/health";
import { reportWebShippedConfig } from "@/lib/ops/shipped-config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { status, body } = await loadHealth({ onReachable: () => { void reportWebShippedConfig(); } });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
