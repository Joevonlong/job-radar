import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The self-hosted fonts, checked from the sources (the rendering itself is checked in e2e/fonts.spec.ts): nothing loads
 * from Google, every file the font rules name exists in the installed packages, the extra-subset rules use the family
 * names next/font gives the latin files, and the font packages are pinned and their licences shipped.
 */
const root = path.resolve(import.meta.dirname, "..");
const layoutPath = path.join(root, "src/app/layout.tsx");
const globalsPath = path.join(root, "src/app/globals.css");
const layout = readFileSync(layoutPath, "utf8");
const globals = readFileSync(globalsPath, "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };

const FONT_PACKAGES = ["@fontsource-variable/archivo", "@fontsource/archivo-black", "@fontsource/ibm-plex-mono", "@fontsource-variable/noto-sans-sc"];
/** The copyright notice each licence file must carry: the upstream one (google/fonts OFL.txt), with any reserved font name. */
const COPYRIGHT: Record<string, string> = {
  "@fontsource-variable/archivo": "Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)",
  "@fontsource/archivo-black": "Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack)",
  "@fontsource/ibm-plex-mono": 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"',
  "@fontsource-variable/noto-sans-sc": "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'",
};
/** The family each next/font/local constant names as its fallback, and the Google family whose metrics it keeps. */
const FALLBACKS: Record<string, { face: string; google: string }> = {
  archivo: { face: "Archivo Fallback", google: "Archivo" },
  archivoBlack: { face: "Archivo Black Fallback", google: "Archivo Black" },
  plexMono: { face: "IBM Plex Mono Fallback", google: "IBM Plex Mono" },
};

/** The SIL OFL 1.1 text from its title to its last line, whitespace collapsed. */
function oflBody(text: string): string {
  const start = text.indexOf("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
  return start < 0 ? "" : text.slice(start).replace(/\s+/g, " ").trim();
}

/** The descriptors of the @font-face rule for one family in globals.css. */
function faceDescriptors(family: string): Record<string, string> {
  const rule = [...globals.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "").find((body) => body.includes(`font-family: "${family}";`));
  if (rule === undefined) return {};
  return Object.fromEntries([...rule.matchAll(/([\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

/** "98.70%" and "98.7%" are the same length. */
const percent = (value: string | undefined): number => Number.parseFloat(value ?? "NaN");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe("self-hosted fonts", () => {
  it("nothing in the app loads a font from Google", () => {
    for (const file of filesUnder(path.join(root, "src")).filter((f) => /\.(tsx?|css)$/.test(f))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/next\/font\/google|fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });

  it("every font file named in layout.tsx and globals.css exists", () => {
    const fromLayout = [...layout.matchAll(/"(\.\.\/\.\.\/node_modules\/[^"]+\.woff2)"/g)].map((m) => m[1] ?? "");
    const fromGlobals = [...globals.matchAll(/url\("(\.\.\/\.\.\/node_modules\/[^"]+\.woff2)"\)/g)].map((m) => m[1] ?? "");
    expect(fromLayout.length).toBeGreaterThanOrEqual(6);
    expect(fromGlobals.length).toBeGreaterThan(0);
    for (const rel of [...fromLayout, ...fromGlobals]) expect(existsSync(path.resolve(path.dirname(layoutPath), rel)), rel).toBe(true);
  });

  it("the extra-subset rules use the family names of the next/font/local constants", () => {
    const constants = [...layout.matchAll(/^const (\w+) = localFont\(/gm)].map((m) => m[1] ?? "");
    expect(constants.sort()).toEqual(["archivo", "archivoBlack", "plexMono"]);
    // the calls themselves must not rename the family (the variable would keep the constant's name)
    expect(layout).not.toMatch(/prop: "font-family"/);
    const families = new Set([...globals.matchAll(/@font-face\s*\{[^}]*?font-family:\s*"([^"]+)"/g)].map((m) => m[1] ?? ""));
    for (const family of families) if (family.endsWith(" Fallback")) families.delete(family);
    expect([...families].sort()).toEqual(constants.sort());
  });

  it("the font packages are pinned to exact versions and their licences are in licenses/fonts", () => {
    const licences = readdirSync(path.join(root, "licenses/fonts"));
    for (const name of FONT_PACKAGES) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      const family = name.split("/")[1] ?? "";
      expect(licences, name).toContain(`${family}-OFL.txt`);
      const licence = readFileSync(path.join(root, "licenses/fonts", `${family}-OFL.txt`), "utf8");
      expect(licence).toContain(`${name}@${pkg.dependencies[name]}`);
      // the full notice: the copyright line, the licensing statement and the complete licence text (the same text the
      // package itself ships, compared with whitespace collapsed)
      expect(licence.split("\n").map((line) => line.trim()), name).toContain(COPYRIGHT[name]);
      expect(licence, name).toContain("This Font Software is licensed under the SIL Open Font License, Version 1.1.");
      const body = oflBody(licence);
      expect(body, name).toMatch(/OTHER DEALINGS IN THE FONT SOFTWARE\.$/);
      expect(body, name).toBe(oflBody(readFileSync(path.join(root, "node_modules", name, "LICENSE"), "utf8")));
    }
  });

  it("the fallback faces keep the metrics next/font/google used for these families", () => {
    // next/font's own table of Google font metrics, the source of the values before the fonts were self-hosted
    const nextRequire = createRequire(createRequire(import.meta.url).resolve("next/package.json"));
    const { getFallbackFontOverrideMetrics } = nextRequire("./dist/compiled/@next/font/dist/google/get-fallback-font-override-metrics.js") as {
      getFallbackFontOverrideMetrics: (family: string) => { ascentOverride: string; descentOverride: string; lineGapOverride: string; sizeAdjust: string };
    };
    for (const [constant, { face }] of Object.entries(FALLBACKS)) {
      const call = layout.slice(layout.indexOf(`const ${constant} = localFont(`)).split("\n});")[0] ?? "";
      expect(call, constant).toContain("adjustFontFallback: false,");
      expect(call, constant).toContain(`fallback: ["${face}"],`);
    }
    for (const { face, google } of [...Object.values(FALLBACKS), { face: "Noto Sans SC Fallback", google: "Noto Sans SC" }]) {
      const rule = faceDescriptors(face);
      expect(rule.src, face).toBe('local("Arial")');
      const expected = getFallbackFontOverrideMetrics(google);
      expect(percent(rule["ascent-override"]), face).toBe(percent(expected.ascentOverride));
      expect(percent(rule["descent-override"]), face).toBe(percent(expected.descentOverride));
      expect(percent(rule["line-gap-override"]), face).toBe(percent(expected.lineGapOverride));
      expect(percent(rule["size-adjust"]), face).toBe(percent(expected.sizeAdjust));
    }
  });
});
