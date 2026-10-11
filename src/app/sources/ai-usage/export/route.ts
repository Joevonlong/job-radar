import { aiUsageCsv } from "@/lib/ai-usage/csv";
import { loadAiUsageCsvRows } from "@/lib/ai-usage/load";

// Reads the database on every request.
export const dynamic = "force-dynamic";

/** CSV of the calls under the same range and filters as the page (newest `csv_max_rows` of them). */
export async function GET(request: Request): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    const { from, to, timeZone, rows } = await loadAiUsageCsvRows(Promise.resolve(query));
    return new Response(aiUsageCsv(rows, timeZone), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ai-usage-${from}-${to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("AI usage data could not be read", { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
