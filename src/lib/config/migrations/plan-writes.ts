/**
 * Everything a deploy's write step would do to the user's files, in one list: the preview before the step, its
 * "anything left?" check after it, and doctor's `config.pending`. Reads only.
 */
import { plannedConfigFiles } from "../init";
import { getConfigPath } from "../paths";
import { ensureProfileFilesPlan } from "../profile";
import type { ConfigName } from "../registry";

import { planConfigMigrations, type FileMigrationProblem } from "./files";

export interface PlanWritesOptions {
  /** Also count the whole files that would turn into overlays. */
  convertOverlays: boolean;
  /** Include the files `config:init` would create. */
  init: boolean;
}

/** What the deploy's write step does; read by `config:plan --deploy` and doctor only. `config:migrate` goes by its own flags. */
export const DEPLOY_WRITE_PLAN: PlanWritesOptions = { convertOverlays: true, init: true };

export interface PlannedConfigWrite {
  /** `migrate`: a structural migration. `convert`: a whole file turns into an overlay. `create`: a file `config:init` creates. */
  kind: "migrate" | "convert" | "create";
  name: ConfigName;
  path: string;
  /** `migrate` and `convert`: config_version from -> to. */
  from?: number;
  to?: number;
}

export interface ConfigWritesPlan {
  writes: PlannedConfigWrite[];
  problems: FileMigrationProblem[];
}

export function planConfigWrites(options: PlanWritesOptions): ConfigWritesPlan {
  const migrations = planConfigMigrations(undefined, { convertOverlays: options.convertOverlays });
  const writes: PlannedConfigWrite[] = migrations.pending.map((item) => ({ kind: item.conversion ? "convert" : "migrate", name: item.name, path: item.path, from: item.from, to: item.to }));
  if (options.init) {
    for (const file of plannedConfigFiles()) writes.push({ kind: "create", name: file.name, path: file.path });
    for (const name of ensureProfileFilesPlan()) writes.push({ kind: "create", name, path: getConfigPath(name) });
  }
  return { writes, problems: migrations.problems };
}
