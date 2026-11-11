import type { JobDetail } from "@/lib/db/queries/job-detail";
import type { CleanText } from "@/lib/mcp/dto/shared";
import { visibleText } from "@/lib/mcp/guard";
import type { StrictCleanResult } from "@/lib/traps/clean";

export interface JobBlockSource {
  detail: JobDetail;
  strict: StrictCleanResult;
  clean: CleanText;
  quote: (quote: string, offset: number | null) => string | null;
}

/**
 * Free text written from a JD quote follows that quote: when the quote hits a trap finding or carries an instruction, the text is
 * the same marker as the quote, since a trap the text repeats in other words is not caught by the instruction patterns.
 */
export function quotedText(source: Pick<JobBlockSource, "clean" | "quote">, text: string, quote: string, offset: number | null): { text: string; quote: string | null } {
  const mapped = source.quote(quote, offset);
  return { text: source.clean(mapped !== null && mapped !== visibleText(quote) ? mapped : text), quote: mapped };
}
