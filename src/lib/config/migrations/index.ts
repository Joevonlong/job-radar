/**
 * The registered config migrations, per config name, oldest first. A config's current version is the `to` of
 * its last step (1 when it has none). See `types.ts` for the contract and where the step files go.
 *
 * Every layered file except models.yaml (which has its own by-id overlay) has an `overlay-format` step, marked
 * `convertOnly` (`overlay-format.ts`): it is crossed only by `config:migrate --write --convert-overlays`.
 */
import type { ConfigName } from "../registry";

import { activityLogOverlayFormat } from "./activity-log/002-overlay-format";
import { ai002 } from "./ai/002-market";
import { ai003 } from "./ai/003-api-providers";
import { aiOverlayFormat } from "./ai/004-overlay-format";
import { breakdownOverlayFormat } from "./breakdown/002-overlay-format";
import { currentScoresOverlayFormat } from "./current-scores/002-overlay-format";
import { deliveryAuditOverlayFormat } from "./delivery-audit/002-overlay-format";
import { insights002 } from "./insights/002-market";
import { insightsOverlayFormat } from "./insights/003-overlay-format";
import { interests002 } from "./interests/002-signal-categories";
import { interests003 } from "./interests/003-market";
import { interestsOverlayFormat } from "./interests/004-overlay-format";
import { jobArchiveOverlayFormat } from "./job-archive/002-overlay-format";
import { jobSearchOverlayFormat } from "./job-search/002-overlay-format";
import { languageOverlayFormat } from "./language/002-overlay-format";
import { mcpPermissions } from "./mcp/003-permissions";
import { mcpOverlayFormat } from "./mcp/002-overlay-format";
import { notify002 } from "./notify/002-high-value";
import { notifyOverlayFormat } from "./notify/003-overlay-format";
import { pipelineBoardOverlayFormat } from "./pipeline-board/002-overlay-format";
import { pipeline002 } from "./pipeline/002-market-packs";
import { pipeline003 } from "./pipeline/003-arbeitnow-priority";
import { pipeline004 } from "./pipeline/004-handpicked-priority";
import { pipeline005 } from "./pipeline/005-berlinstartupjobs-priority";
import { pipelineOverlayFormat } from "./pipeline/006-overlay-format";
import { preferences002 } from "./preferences/002-market";
import { preferences003 } from "./preferences/003-places";
import { repliesOverlayFormat } from "./replies/002-overlay-format";
import { researchOverlayFormat } from "./research/002-overlay-format";
import { resumeOverlayFormat } from "./resume/002-overlay-format";
import { salary002 } from "./salary/002-drop-include-ai-lookups";
import { salaryOverlayFormat } from "./salary/003-overlay-format";
import { scheduleOverlayFormat } from "./schedule/002-overlay-format";
import { search002 } from "./search/002-market";
import { searchOverlayFormat } from "./search/003-overlay-format";
import { setupOverlayFormat } from "./setup/002-overlay-format";
import { signalPresetsOverlayFormat } from "./signal-presets/002-overlay-format";
import { sources002 } from "./sources/002-market";
import { sources003 } from "./sources/003-arbeitnow";
import { sources004 } from "./sources/004-monid";
import { sources005 } from "./sources/005-handpicked";
import { sources006 } from "./sources/006-berlin-design-network";
import { sources007 } from "./sources/007-berlinstartupjobs";
import { sources008 } from "./sources/008-apify-exact-window";
import { sources009 } from "./sources/009-stepstone-robots";
import { sourcesOverlayFormat } from "./sources/010-overlay-format";
import { trapsOverlayFormat } from "./traps/002-overlay-format";
import type { ConfigMigration } from "./types";
import { ui002 } from "./ui/002-visibility-blocks";
import { uiOverlayFormat } from "./ui/003-overlay-format";
import { careerOverlayFormat } from "./career/002-overlay-format";
import { writerOverlayFormat } from "./writer/002-overlay-format";

export type { ConfigMigration } from "./types";

export const CONFIG_MIGRATIONS: Readonly<Partial<Record<ConfigName, readonly ConfigMigration[]>>> = {
  career: [careerOverlayFormat],
  activityLog: [activityLogOverlayFormat],
  ai: [ai002, ai003, aiOverlayFormat],
  breakdown: [breakdownOverlayFormat],
  channels: [sources002, sources003, sources004, sources005, sources006, sources007, sources008, sources009, sourcesOverlayFormat],
  currentScores: [currentScoresOverlayFormat],
  deliveryAudit: [deliveryAuditOverlayFormat],
  insights: [insights002, insightsOverlayFormat],
  interests: [interests002, interests003, interestsOverlayFormat],
  jobArchive: [jobArchiveOverlayFormat],
  jobSearch: [jobSearchOverlayFormat],
  language: [languageOverlayFormat],
  mcp: [mcpOverlayFormat, mcpPermissions],
  notify: [notify002, notifyOverlayFormat],
  pipeline: [pipeline002, pipeline003, pipeline004, pipeline005, pipelineOverlayFormat],
  pipelineBoard: [pipelineBoardOverlayFormat],
  preferences: [preferences002, preferences003],
  replies: [repliesOverlayFormat],
  research: [researchOverlayFormat],
  resume: [resumeOverlayFormat],
  salary: [salary002, salaryOverlayFormat],
  schedule: [scheduleOverlayFormat],
  search: [search002, searchOverlayFormat],
  setup: [setupOverlayFormat],
  signalPresets: [signalPresetsOverlayFormat],
  traps: [trapsOverlayFormat],
  ui: [ui002, uiOverlayFormat],
  writer: [writerOverlayFormat],
};
