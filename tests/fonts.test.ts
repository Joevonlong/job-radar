import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    families.delete("Noto Sans SC Fallback");
    expect([...families].sort()).toEqual(constants.sort());
  });

  it("the font packages are pinned to exact versions and their licences are in licenses/fonts", () => {
    const licences = readdirSync(path.join(root, "licenses/fonts"));
    for (const name of FONT_PACKAGES) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      const family = name.split("/")[1] ?? "";
      expect(licences, name).toContain(`${family}-OFL.txt`);
      expect(readFileSync(path.join(root, "licenses/fonts", `${family}-OFL.txt`), "utf8")).toContain(`${name}@${pkg.dependencies[name]}`);
    }
  });
});
