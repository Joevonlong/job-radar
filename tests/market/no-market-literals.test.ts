// @vitest-environment node
/**
 * The code names no country, currency or local language of its own; they come from the market (preferences.yaml +
 * packs). String literals in src/ (comments stripped) are searched for the German market's values; the allowlist holds
 * the places that must name them (migrations from the German-only versions, the read fallback for old rows, demo data).
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "../../src");
const LITERAL = /(["'`])(?:DE|EUR|Germany|Deutschland|germany|de-DE|Europe\/Berlin|Berlin|München|Munich|€)\1/;
const ALLOW = [
  /^lib\/config\/migrations\//, // the old German-only config becomes the DE market
  /^lib\/db\/seed\.ts$/, // demo data of a German instance
  /^app\/dev\//, // component demos
  /^lib\/domain\/types\.ts$/, // LEGACY_BASE_CURRENCY: rows written before base currencies were EUR
  /^lib\/config\/schemas\/interests\.ts$/, // interests.yaml's currency keys move in its own migration
  /^lib\/channels\/(?:arbeitsagentur|stepstone|xing)\//, // German job boards: their own country names and currency
  /^lib\/channels\/(?:currency\.ts|ats\/text\.ts|jsearch\/parse\.ts)$/, // currency symbols and HTML entities -> ISO codes
  /^lib\/settings\/fields\.ts$/, // a key named `*_eur` is in euros
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const stripComments = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("no hard-coded market", () => {
  it("src/ has no country, currency or city literal of the German market outside the allowlist", () => {
    const hits: string[] = [];
    for (const file of files(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (ALLOW.some((re) => re.test(rel))) continue;
      stripComments(fs.readFileSync(file, "utf8"))
        .split("\n")
        .forEach((line, i) => {
          if (LITERAL.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });
});
