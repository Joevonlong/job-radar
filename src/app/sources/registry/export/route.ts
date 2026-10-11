import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { exportSources } from "@/lib/sources/registry/service";

// The file is read per request: the export is what sources.yaml holds right now.
export const dynamic = "force-dynamic";

const querySchema = z.object({ format: z.enum(["yaml", "json"]).default("yaml") });

/** `GET /sources/registry/export?format=yaml|json`: the file text (comments included) or the validated values; proxy credentials are masked. */
export async function GET(request: Request): Promise<Response> {
  const query = querySchema.safeParse({ format: new URL(request.url).searchParams.get("format") ?? undefined });
  if (!query.success) return Response.json({ error: "invalid_format" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  let timeZone = "UTC";
  try {
    timeZone = loadConfig("schedule").timezone;
  } catch {
    // a broken schedule.yaml must not stop the export: the file name is then in UTC
  }
  const result = exportSources(query.data.format, { now: new Date(), timeZone });
  if ("error" in result) {
    // an unreadable file can still be downloaded as YAML text (to fix it by hand); JSON needs valid values
    return Response.json({ error: result.error }, { status: result.error === "missing" ? 404 : 409, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(result.body, {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
