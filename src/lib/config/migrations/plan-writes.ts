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
  /** Overlay conversion. No conversion exists in this version. */
  convertOverlays: boolean;
  /** Include the files `config:init` would create. */
  init: boolean;
}

/** What the deploy's write step does; read by `config:plan --deploy` and doctor only. `config:migrate` goes by its own flags. */
export const DEPLOY_WRITE_PLAN: PlanWritesOptions = { convertOverlays: false, init: true };

export interface PlannedConfigWrite {
  /** `migrate`: a structural migration. `create`: a file `config:init` creates. */
  kind: "migrate" | "create";
  name: ConfigName;
  path: string;
  /** `migrate` only: config_version from -> to. */
  from?: number;
  to?: number;
}

export interface ConfigWritesPlan {
  writes: PlannedConfigWrite[];
  problems: FileMigrationProblem[];
}

export function planConfigWrites(options: PlanWritesOptions): ConfigWritesPlan {
  const migrations = planConfigMigrations();
  const writes: PlannedConfigWrite[] = migrations.pending.map((item) => ({ kind: "migrate", name: item.name, path: item.path, from: item.from, to: item.to }));
  if (options.init) {
    for (const file of plannedConfigFiles()) writes.push({ kind: "create", name: file.name, path: file.path });
    for (const name of ensureProfileFilesPlan()) writes.push({ kind: "create", name, path: getConfigPath(name) });
  }
  return { writes, problems: migrations.problems };
}
