import type { FieldBlock } from "@/lib/capabilities/blocks";
import { breakdownBlockDto, companyBlockDto, ghostBlockDto, lifecycleBlockDto, salaryBlockDto, syncCompanyBlockDto, syncSalaryBlockDto, translationBlockDto } from "@/lib/mcp/dto/job-analysis";
import { matchBlockDto } from "@/lib/mcp/dto/job-match";
import { trackingBlockDto } from "@/lib/mcp/dto/job-tracking";
import { notesBlockDto } from "@/lib/mcp/dto/notes";

import { loadBreakdown, loadCompany, loadGhost, loadLifecycle, loadSalary, loadSyncCompany, loadSyncSalary, loadTranslation } from "./analysis";
import { loadMatch } from "./match";
import { loadNotes } from "./notes";
import type { JobBlockSource } from "./source";
import { loadTracking } from "./tracking";

export const getJobBlocks = [
  { key: "translation", permission: "jobs:read", schema: translationBlockDto, onRequest: true, load: loadTranslation },
  { key: "breakdown", permission: "jobs:read", schema: breakdownBlockDto, onRequest: true, load: loadBreakdown },
  { key: "salary", permission: "jobs:read", schema: salaryBlockDto, onRequest: true, load: loadSalary },
  { key: "company", permission: "jobs:read", schema: companyBlockDto, onRequest: true, load: loadCompany },
  { key: "ghost", permission: "jobs:read", schema: ghostBlockDto, onRequest: true, load: loadGhost },
  { key: "lifecycle", permission: "jobs:read", schema: lifecycleBlockDto, onRequest: true, load: loadLifecycle },
  { key: "match", permission: "match:read", schema: matchBlockDto, onRequest: false, load: loadMatch },
  { key: "tracking", permission: "tracking:read", schema: trackingBlockDto, onRequest: false, load: loadTracking },
  { key: "notes", permission: "notes:read", schema: notesBlockDto, onRequest: false, load: loadNotes },
] as const satisfies readonly FieldBlock<JobBlockSource>[];

/** Sync selects every optional block explicitly and exports source times for research results. */
export const syncJobBlocks = getJobBlocks.map((block): FieldBlock<JobBlockSource> => {
  if (block.key === "company") return { ...block, schema: syncCompanyBlockDto, load: loadSyncCompany };
  if (block.key === "salary") return { ...block, schema: syncSalaryBlockDto, load: loadSyncSalary };
  return { ...block, onRequest: true };
});
