import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { CleanText } from "@/lib/mcp/dto/shared";
import type { StrictCleanResult } from "@/lib/traps/clean";

export interface JobBlockSource {
  detail: JobDetail;
  strict: StrictCleanResult;
  clean: CleanText;
  quote: (quote: string, offset: number | null) => string | null;
}
