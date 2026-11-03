// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ConfigError, loadConfig, modelsSchema, resetConfigCache } from "@/lib/config";
import { renderFullModelsText, writeFullModels, writeModelsOverlay } from "@/lib/config/models-overlay-write";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
});
afterEach(() => tmp.cleanup());

const userFile = () => path.join(tmp.configDir, "models.yaml");
const entry = (id: string, input = 0.2, output = 0.4) => ({ id, label: id.toUpperCase(), price: { input_per_mtok: input, output_per_mtok: output }, notes: "synced 2026-11-01" });
const openrouterIds = () => loadConfig("models").providers.openrouter.models.map((m) => m.id);

describe("writeModelsOverlay", () => {
  it("creates the user's file with only the added entries, and the catalog sees them at once", async () => {
    await writeModelsOverlay("openrouter", [entry("vendor/a"), entry("vendor/b")]);
    const written = parse(fs.readFileSync(userFile(), "utf8")) as { providers: Record<string, { models: { id: string }[] }> };
    expect(Object.keys(written.providers)).toEqual(["openrouter"]);
    expect(written.providers.openrouter!.models.map((m) => m.id)).toEqual(["vendor/a", "vendor/b"]);
    expect(fs.readFileSync(userFile(), "utf8")).toMatch(/^# Your additions/);
    expect(openrouterIds()).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/a", "vendor/b"]);
    expect(fs.statSync(userFile()).mode & 0o777).toBe(0o600);
  });

  it("replaces an entry of the user's file with the same id as a whole and keeps the comments around it", async () => {
    fs.writeFileSync(userFile(), "# my notes\nproviders:\n  openrouter:\n    models:\n      # keep this one\n      - { id: vendor/a, label: Old, price: { input_per_mtok: 9, output_per_mtok: 9 } }\n      - { id: vendor/keep, price: { input_per_mtok: 1, output_per_mtok: 1 } }\n");
    await writeModelsOverlay("openrouter", [entry("vendor/a", 0.1, 0.2), entry("vendor/c")]);
    const text = fs.readFileSync(userFile(), "utf8");
    expect(text).toContain("# my notes");
    expect(text).toContain("# keep this one");
    expect(openrouterIds()).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/a", "vendor/keep", "vendor/c"]);
    expect(loadConfig("models").providers.openrouter.models.find((m) => m.id === "vendor/a")).toMatchObject({ label: "VENDOR/A", price: { input_per_mtok: 0.1 } });
  });

  it("keeps the padding of flow collections the file already uses, in the lines it does not change", async () => {
    fs.writeFileSync(userFile(), "providers:\n  openrouter:\n    models:\n      - { id: vendor/keep, aliases: [ k1, k2 ], price: { input_per_mtok: 1, output_per_mtok: 1 } }\n");
    await writeModelsOverlay("openrouter", [entry("vendor/new")]);
    const text = fs.readFileSync(userFile(), "utf8");
    expect(text).toContain("- { id: vendor/keep, aliases: [ k1, k2 ], price: { input_per_mtok: 1, output_per_mtok: 1 } }");
  });

  it("a catalog that does not validate is named at the user's file positions", async () => {
    fs.writeFileSync(userFile(), "providers:\n  openrouter:\n    models:\n      - id: vendor/keep\n");
    const failure = await writeModelsOverlay("openrouter", [entry("vendor/new")]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).issues.map((issue) => issue.path)).toEqual(["providers.openrouter.models[0].price"]);
  });

  it("updating a shipped model puts a full replacement in the user's file and leaves the shipped file alone", async () => {
    const shippedBefore = fs.readFileSync(path.join(tmp.defaultsDir, "models.yaml"), "utf8");
    const current = loadConfig("models").providers.openrouter.models[0]!;
    await writeModelsOverlay("openrouter", [{ ...current, price: { input_per_mtok: 0.05, output_per_mtok: 0.6 } }]);
    expect(loadConfig("models").providers.openrouter.models[0]?.price?.input_per_mtok).toBe(0.05);
    expect(fs.readFileSync(path.join(tmp.defaultsDir, "models.yaml"), "utf8")).toBe(shippedBefore);
  });

  it("refuses a result that is not a valid catalog, leaves the file as it was and names the user's file", async () => {
    fs.writeFileSync(userFile(), "providers: {}\n");
    const bad = { id: "vendor/no-price" };
    const failure = await writeModelsOverlay("openrouter", [bad]).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).filePath).toBe(userFile());
    expect(fs.readFileSync(userFile(), "utf8")).toBe("providers: {}\n");
    const clash = await writeModelsOverlay("openrouter", [{ ...entry("vendor/x"), aliases: ["vendor/x"] }]).catch((e: unknown) => e);
    expect(clash).toBeInstanceOf(ConfigError);
    expect(fs.readFileSync(userFile(), "utf8")).toBe("providers: {}\n");
  });

  it("reads the newest file inside the lock: two writers at once both land", async () => {
    await Promise.all(["vendor/a", "vendor/b", "vendor/c", "vendor/d"].map((id) => writeModelsOverlay("openrouter", [entry(id)])));
    resetConfigCache();
    expect(openrouterIds().sort()).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/a", "vendor/b", "vendor/c", "vendor/d"]);
  });

  it("a change made to the file by hand just before is kept, not overwritten from a stale read", async () => {
    await writeModelsOverlay("openrouter", [entry("vendor/a")]);
    fs.appendFileSync(userFile(), "      - { id: vendor/by-hand, price: { input_per_mtok: 1, output_per_mtok: 1 } }\n");
    await writeModelsOverlay("openrouter", [entry("vendor/b")]);
    expect(openrouterIds()).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/a", "vendor/by-hand", "vendor/b"]);
  });
});

describe("models:export --full", () => {
  it("writes the effective catalog as a complete file that the catalog schema accepts and that loads back to the same catalog", async () => {
    await writeModelsOverlay("openrouter", [entry("vendor/a")]);
    const effective = structuredClone(loadConfig("models"));
    const written = await writeFullModels();
    expect(written.file).toBe(userFile());
    expect(written.backup).not.toBeNull();
    const text = fs.readFileSync(userFile(), "utf8");
    expect(modelsSchema.safeParse(parse(text)).success).toBe(true);
    // an older version reads the file as the whole catalog: it must hold every provider and every model
    expect(parse(text).providers.openrouter.models.map((m: { id: string }) => m.id)).toEqual(effective.providers.openrouter.models.map((m) => m.id));
    resetConfigCache();
    expect(loadConfig("models")).toEqual(effective);
  });

  it("renders to stdout text or to another file without touching the user's file", async () => {
    const text = renderFullModelsText(loadConfig("models"));
    expect(modelsSchema.safeParse(parse(text)).success).toBe(true);
    const out = path.join(tmp.root, "full.yaml");
    await writeFullModels(out);
    expect(fs.readFileSync(out, "utf8")).toBe(text);
    expect(fs.existsSync(userFile())).toBe(false);
  });

  it("refuses another file in the locked directories", async () => {
    const out = path.join(path.dirname(userFile()), "ui.yaml");
    const before = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
    await expect(writeFullModels(out)).rejects.toThrow(/config or profile directory/);
    expect(fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null).toBe(before);
  });
});
