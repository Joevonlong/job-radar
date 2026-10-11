/**
 * pnpm market:show [--json]
 *
 * Prints the market Job Radar works in (preferences.yaml `market` + the packs in config/packs/): the pack and whether a
 * user copy replaces the shipped one, home country, base currency, local language, whether the local-language step is
 * on, and which channels run in this market. Reads only.
 *
 * Exit code: 0 = the market resolves, 2 = it does not (every market step is skipped until it does), 3 = bad arguments.
 */
import { parseArgs } from "node:util";

import { summarizeMarket } from "../src/lib/market/summary";

function main(): number {
  let json = false;
  try {
    json = parseArgs({ options: { json: { type: "boolean" } }, strict: true }).values.json === true;
  } catch (error) {
    console.error(`market:show: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 3;
  }
  const result = summarizeMarket();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  }
  if (!result.ok) {
    console.log(`✗ market cannot be resolved: ${result.reason}`);
    console.log("  Fix preferences.yaml `market` (or the market block on /me); until then the market steps are skipped.");
    return 2;
  }
  const s = result.summary;
  console.log(`pack            ${s.packId} (${s.packName}) — ${s.packLayer === "user" ? `user copy ${s.packDir} (replaces the shipped pack)` : "shipped"}`);
  console.log(`home country    ${s.country} (${s.countryName})${s.homeRegion ? `, region ${s.homeRegion}` : ""}`);
  console.log(`base currency   ${s.currency}`);
  console.log(`local language  ${s.homeLanguage} — language step ${s.languageStep ? "on" : "off (no requirement rules for it: nothing is read or deducted)"}`);
  console.log(`locale          ${s.locale}`);
  if (s.channels === null) {
    console.log(`channels        sources.yaml cannot be read: ${s.channelsError ?? "unknown error"}`);
    return 0;
  }
  console.log(`channels on     ${s.channels.running.join(", ") || "(none)"}`);
  if (s.channels.localOff.length > 0) console.log(`local, off      ${s.channels.localOff.join(", ")} (this market's own job boards; turn them on in /sources/registry or on /me)`);
  if (s.channels.otherMarket.length > 0) console.log(`other markets   ${s.channels.otherMarket.map((c) => `${c.id} [${c.markets.join(", ")}]`).join(", ")} (not run here)`);
  return 0;
}

process.exit(main());
