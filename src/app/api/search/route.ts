import { getSchedule } from "@/lib/dashboard/context";
import { getDb, listJobs } from "@/lib/db";
import { searchLocationTerms } from "@/lib/jobs/cities";

// The ⌘K palette asks per keystroke: always the live database.
export const dynamic = "force-dynamic";

/** Most jobs the palette lists. */
const MAX_RESULTS = 8;

export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ jobs: [] }, { headers: { "Cache-Control": "no-store" } });
  try {
    const page = await listJobs(getDb(), {
      filters: { q, qLocationTerms: searchLocationTerms(q), includeFiltered: false },
      sort: "rank",
      page: 1,
      pageSize: MAX_RESULTS,
      timezone: getSchedule().timezone,
    });
    const jobs = page.jobs.map((job) => ({ id: job.id, title: job.title, company: job.companyName, location: job.locations[0]?.label ?? null, rank: job.rank?.rankValue ?? null }));
    return Response.json({ jobs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[search] failed:", error instanceof Error ? error.name : "unknown error");
    return Response.json({ jobs: [] }, { status: 500 });
  }
}
