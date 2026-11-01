/**
 * The registered config migrations, per config name, oldest first. A config's current version is the `to` of
 * its last step (1 when it has none). See `types.ts` for the contract and where the step files go.
 */
import type { ConfigName } from "../registry";

import { ai002 } from "./ai/002-market";
import { ai003 } from "./ai/003-api-providers";
import { insights002 } from "./insights/002-market";
import { interests002 } from "./interests/002-signal-categories";
import { interests003 } from "./interests/003-market";
import { notify002 } from "./notify/002-high-value";
import { pipeline002 } from "./pipeline/002-market-packs";
import { pipeline003 } from "./pipeline/003-arbeitnow-priority";
import { preferences002 } from "./preferences/002-market";
import { salary002 } from "./salary/002-drop-include-ai-lookups";
import { search002 } from "./search/002-market";
import { sources002 } from "./sources/002-market";
import { sources003 } from "./sources/003-arbeitnow";
import { sources004 } from "./sources/004-monid";
import type { ConfigMigration } from "./types";
import { ui002 } from "./ui/002-visibility-blocks";

export type { ConfigMigration } from "./types";

export const CONFIG_MIGRATIONS: Readonly<Partial<Record<ConfigName, readonly ConfigMigration[]>>> = {
  interests: [interests002, interests003],
  notify: [notify002],
  ui: [ui002],
  preferences: [preferences002],
  search: [search002],
  channels: [sources002, sources003, sources004],
  pipeline: [pipeline002, pipeline003],
  ai: [ai002, ai003],
  insights: [insights002],
  salary: [salary002],
};
