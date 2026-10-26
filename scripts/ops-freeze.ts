/** Create or clear the upgrade freeze. Never print the token, including on errors. No environment file is loaded. */
import { parseArgs } from "node:util";

import { freezeConfig, unfreezeConfig } from "../src/lib/config/write-lock";
import { getTranslator } from "../src/lib/i18n/node";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { unfreeze: { type: "boolean" }, owned: { type: "boolean" }, target: { type: "string" } }, strict: true, allowPositionals: false });
  const t = getTranslator("configOps", "cli");
  if (values.unfreeze) {
    if (values.owned && !process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN) throw new Error("missing freeze token");
    await unfreezeConfig(values.owned ? process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN : undefined);
    console.log(t("unfrozen"));
  } else {
    await freezeConfig(values.target ?? "", process.env.JOB_RADAR_UPGRADE_FREEZE_TOKEN);
    console.log(t("frozen"));
  }
}

main().catch(() => {
  console.error(getTranslator("configOps", "cli")("failed"));
  process.exitCode = 1;
});
