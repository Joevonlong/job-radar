import { z } from "zod";

import { getSchedule } from "@/lib/dashboard/context";
import { getDb, listJobs } from "@/lib/db";
import { buildSearchPlan, jobSearchSettings } from "@/lib/jobs/search";

// The ⌘K palette asks per keystroke: always the live database.
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const settings = jobSearchSettings();
    const input = z.object({ q: z.string().trim() }).safeParse({ q: new URL(request.url).searchParams.get("q") ?? "" });
    const q = input.success ? input.data.q.slice(0, settings.query.max_chars) : "";
    if (q.length < settings.palette.min_chars) return Response.json({ jobs: [] }, { headers: { "Cache-Control": "no-store" } });
    const page = await listJobs(getDb(), {
      filters: { search: buildSearchPlan(q), includeFiltered: false },
      sort: "relevance",
      page: 1,
      pageSize: settings.palette.limit,
      timezone: getSchedule().timezone,
    });
    const jobs = page.jobs.map((job) => ({ id: job.id, title: job.title, company: job.companyName, location: job.locations[0]?.label ?? null, rank: job.rank?.rankValue ?? null }));
    return Response.json({ jobs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[search] failed:", error instanceof Error ? error.name : "unknown error");
    return Response.json({ jobs: [] }, { status: 500 });
  }
}
