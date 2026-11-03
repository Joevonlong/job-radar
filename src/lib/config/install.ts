/** Which config files a directory holds (doctor, `config:init --from`). */
import fs from "node:fs";
import path from "node:path";

import { getConfigDir } from "./paths";
import { configRegistry, LAYERED_CONFIG_NAMES } from "./registry";

/** The config files of a directory that count as "configured before" (every layered config file). */
export function installedConfigFiles(dir: string = getConfigDir()): string[] {
  const names = LAYERED_CONFIG_NAMES.map((name) => configRegistry[name].file);
  return names.filter((file) => fs.existsSync(/*turbopackIgnore: true*/ path.join(dir, file)));
}
