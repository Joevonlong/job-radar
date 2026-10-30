import type { PipelineConfig } from "@/lib/config";
import { resolveCompanyName } from "@/lib/pipeline/company";
import type { Channel, RawPostingInput } from "./types";

/** Keep parse failures for the pipeline, and discard only successfully parsed, unrelated employers. */
export function keepCompanyMatches(records: readonly RawPostingInput[], channel: Channel, keys: ReadonlySet<string>, pipeline: PipelineConfig): {
  kept: RawPostingInput[]; dropped: number; droppedNames: string[];
} {
  const kept: RawPostingInput[] = [];
  const droppedNames: string[] = [];
  let dropped = 0;
  for (const record of records) {
    try {
      const name = channel.parse(record.payload).companyName;
      if (!keys.has(resolveCompanyName(name, pipeline).nameNorm)) {
        dropped += 1;
        if (droppedNames.length < 3 && !droppedNames.includes(name)) droppedNames.push(name);
        continue;
      }
    } catch { /* The raw record must survive a parse failure. */ }
    kept.push(record);
  }
  return { kept, dropped, droppedNames };
}
