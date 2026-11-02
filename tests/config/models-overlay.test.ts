// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { inspectModelsOverlay, loadConfig, mergeModelsOverlay, modelsSchema, parseConfigText, readConfigText, refreshConfigCache, validateConfigText } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

type Section = { label: string; models: Record<string, unknown>[] };
const price = (input: number, output: number) => ({ input_per_mtok: input, output_per_mtok: output });
const section = (...models: Record<string, unknown>[]): Section => ({ label: "Provider", models });

/** A shipped catalog with every provider, the openrouter section as given. */
function shipped(openrouter: Section, codex: Section = section({ id: "cx-a", cli_default: true }, { id: "cx-b" })): { providers: Record<string, Section> } {
  const cli = section({ id: "c1" });
  return {
    providers: {
      "claude-cli": cli,
      "codex-cli": codex,
      anthropic: section({ id: "a1", price: price(1, 2) }),
      openai: section({ id: "o1", price: price(1, 2) }),
      openrouter,
      deepseek: section({ id: "d1", price: price(1, 2) }),
      mimo: section({ id: "m1", price: price(1, 2) }),
    },
  };
}
const mergedOpenRouter = (shippedValue: unknown, user: unknown) => {
  const result = mergeModelsOverlay(shippedValue, user);
  return { ...result, models: ((result.value as { providers: Record<string, Section> }).providers.openrouter?.models ?? []) as Record<string, unknown>[] };
};

const base = shipped(section({ id: "x/one", label: "One", price: price(1, 2), aliases: ["x/one-dated"] }, { id: "x/two", price: price(3, 4) }));

describe("overlay merge", () => {
  it("a user model with a known id replaces the shipped entry as a whole, a new id follows the shipped ones", () => {
    const { models, errors } = mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/new", price: price(9, 9) }, { id: "x/one", price: price(5, 6) }] } } });
    expect(errors).toEqual([]);
    expect(models.map((m) => m.id)).toEqual(["x/one", "x/two", "x/new"]);
    // no field-level merge: the label and aliases of the shipped entry are gone with it
    expect(models[0]).toEqual({ id: "x/one", price: price(5, 6) });
  });

  it("a section the user file lacks is the shipped one, and the user's section keeps the shipped label unless it sets one", () => {
    const { value } = mergeModelsOverlay(base, { providers: { openrouter: { notes: "mine" } } });
    const providers = (value as { providers: Record<string, Section & { notes?: string }> }).providers;
    expect(providers.openrouter).toMatchObject({ label: "Provider", notes: "mine", models: base.providers.openrouter!.models });
    expect(providers.mimo).toEqual(base.providers.mimo);
  });

  it("deprecated with just an id hides the shipped model and keeps its price", () => {
    const { models, errors } = mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/two", deprecated: true }] } } });
    expect(errors).toEqual([]);
    expect(models.find((m) => m.id === "x/two")).toEqual({ id: "x/two", price: price(3, 4), deprecated: true });
  });

  it("hiding a shipped model drops the shipped aliases that clash with a user id, so the file stays valid", () => {
    // the user hides x/one and, in the same file, adds a model whose id is x/one's shipped alias
    const { models, errors, value } = mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/one", deprecated: true }, { id: "x/one-dated", price: price(1, 1) }] } } });
    expect(errors).toEqual([]);
    expect(models.find((m) => m.id === "x/one")).toEqual({ id: "x/one", label: "One", price: price(1, 2), deprecated: true });
    expect(modelsSchema.safeParse(value).success).toBe(true);
    // a shipped alias nobody else claims stays on the hidden model
    expect(mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/one", deprecated: true }] } } }).models.find((m) => m.id === "x/one")?.aliases).toEqual(["x/one-dated"]);
  });

  it("cli_default in the user layer disables the shipped one", () => {
    const user = { providers: { "codex-cli": { models: [{ id: "cx-b", cli_default: true }] } } };
    const result = mergeModelsOverlay(base, user).value as { providers: Record<string, Section> };
    expect(result.providers["codex-cli"]!.models).toEqual([{ id: "cx-a" }, { id: "cx-b", cli_default: true }]);
    expect(modelsSchema.safeParse(result).success).toBe(true);
    // a user entry that hides the shipped default keeps no stale cli_default either
    const hide = mergeModelsOverlay(base, { providers: { "codex-cli": { models: [{ id: "cx-a", deprecated: true }, { id: "cx-c", cli_default: true }] } } }).value as { providers: Record<string, Section> };
    expect(hide.providers["codex-cli"]!.models.filter((m) => m.cli_default === true).map((m) => m.id)).toEqual(["cx-c"]);
  });

  it("two cli_default models in the user layer are an error at the second one", () => {
    const { errors } = mergeModelsOverlay(base, { providers: { "codex-cli": { models: [{ id: "u1", cli_default: true }, { id: "u2", cli_default: true }] } } });
    expect(errors).toEqual([{ path: ["providers", "codex-cli", "models", 1, "cli_default"], message: "only one model can be the CLI default" }]);
  });

  it("a user alias equal to a shipped model id is dropped with a warning: the shipped id wins (a new release shipped the id the user had as an alias)", () => {
    const { models, warnings, errors } = mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/mine", price: price(1, 1), aliases: ["x/two", "x/keep"] }] } } });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([{ path: ["providers", "openrouter", "models", 0, "aliases", 0], message: expect.stringContaining('"x/two"') }]);
    expect(models.find((m) => m.id === "x/mine")?.aliases).toEqual(["x/keep"]);
    expect(modelsSchema.safeParse(mergeModelsOverlay(base, { providers: { openrouter: { models: [{ id: "x/mine", price: price(1, 1), aliases: ["x/two"] }] } } }).value).success).toBe(true);
  });

  it("a user id or alias equal to a shipped alias takes it over: the shipped alias is dropped", () => {
    const byId = mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/one-dated", price: price(1, 1) }] } } });
    expect(byId.models.find((m) => m.id === "x/one")).not.toHaveProperty("aliases");
    const byAlias = mergedOpenRouter(base, { providers: { openrouter: { models: [{ id: "x/mine", price: price(1, 1), aliases: ["x/one-dated"] }] } } });
    expect(byAlias.models.find((m) => m.id === "x/one")).not.toHaveProperty("aliases");
    expect(byAlias.models.find((m) => m.id === "x/mine")?.aliases).toEqual(["x/one-dated"]);
    expect(modelsSchema.safeParse(byAlias.value).success).toBe(true);
  });

  it("clashes inside the user layer are errors that name the user's path", () => {
    const { errors } = mergeModelsOverlay(base, {
      providers: { openrouter: { models: [{ id: "u1", price: price(1, 1), aliases: ["u2"] }, { id: "u2", price: price(1, 1) }, { id: "u1", price: price(1, 1) }] } },
    });
    expect(errors.map((e) => e.path.join("."))).toEqual(expect.arrayContaining(["providers.openrouter.models.2.id", "providers.openrouter.models.0.aliases.0"]));
  });

  it("reports unknown keys and providers at their paths", () => {
    const { errors } = mergeModelsOverlay(base, { providers: { nebius: { models: [] }, openrouter: { models: [{ id: "x", bogus: 1 }] } } });
    expect(errors.map((e) => e.path.join("."))).toEqual(expect.arrayContaining(["providers.nebius", "providers.openrouter.models.0.bogus"]));
  });

  it("a whole older copy: its models plus the shipped models it lacks, nothing of the shipped copy of the same id", () => {
    const copy = structuredClone(base);
    copy.providers.openrouter!.models = [{ id: "x/one", label: "My one", price: price(7, 7) }];
    const { models, errors } = mergedOpenRouter(base, copy);
    expect(errors).toEqual([]);
    expect(models).toEqual([{ id: "x/one", label: "My one", price: price(7, 7) }, { id: "x/two", price: price(3, 4) }]);
  });

  it("leaves what is not a providers mapping to the schema and never changes its inputs", () => {
    expect(mergeModelsOverlay(base, null).value).toBeNull();
    expect(mergeModelsOverlay(base, { providers: [] }).value).toEqual({ providers: [] });
    const user = { providers: { openrouter: { models: [{ id: "x/one", price: price(1, 1) }] } } };
    const beforeUser = structuredClone(user);
    const beforeShipped = structuredClone(base);
    mergeModelsOverlay(base, user);
    expect(user).toEqual(beforeUser);
    expect(base).toEqual(beforeShipped);
  });
});

describe("overlay in the loader", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
    process.env.JOB_RADAR_CONFIG_POLL_MS = "0";
  });
  afterEach(() => tmp.cleanup());

  const userFile = () => path.join(tmp.configDir, "models.yaml");
  const shippedFile = () => path.join(tmp.defaultsDir, "models.yaml");
  const ids = (provider: "openrouter" | "openai") => loadConfig("models").providers[provider].models.map((m) => m.id);

  it("without a user file the catalog is the shipped one", () => {
    expect(ids("openrouter")).toEqual(["deepseek/deepseek-v4.1-flash"]);
  });

  it("a user file with only additions loads: the shipped models stay, the user's follow, the catalog validates", () => {
    fs.writeFileSync(userFile(), "providers:\n  openrouter:\n    models:\n      - id: vendor/model-x\n        label: Model X\n        price: { input_per_mtok: 0.2, output_per_mtok: 0.4 }\n");
    expect(ids("openrouter")).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/model-x"]);
    expect(ids("openai")).toEqual(["gpt-6-luna"]);
    expect(modelsSchema.safeParse(loadConfig("models")).success).toBe(true);
  });

  it("an entry without a price on an API provider still fails, and the error points at the user's file", () => {
    fs.writeFileSync(userFile(), "providers:\n  openrouter:\n    models:\n      - id: vendor/model-x\n");
    expect(() => parseConfigText("models", readConfigText("models"))).toThrow(/price/);
    const checked = validateConfigText("models", fs.readFileSync(userFile(), "utf8"));
    expect(checked.ok).toBe(false);
  });

  it("a problem of the merged catalog is named at the model's place in the user's file, not in the merged list", () => {
    // the shipped fixture has one openrouter model: the user's broken entry is merged at index 1 but sits at index 0 of the file
    const text = "providers:\n  openrouter:\n    models:\n      - id: vendor/model-x\n";
    expect(() => parseConfigText("models", text)).toThrow(/providers\.openrouter\.models\[0\]\.price/);
    expect(() => parseConfigText("models", text)).not.toThrow(/models\[1\]/);
  });

  it("clashes in the user layer are reported by the editor's validation at the user's own line", () => {
    const text = "providers:\n  openrouter:\n    models:\n      - { id: a/b, price: { input_per_mtok: 1, output_per_mtok: 1 } }\n      - { id: a/b, price: { input_per_mtok: 1, output_per_mtok: 1 } }\n";
    const checked = validateConfigText("models", text);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues[0]).toMatchObject({ path: "providers.openrouter.models[1].id", line: 5, source: "schema" });
  });

  it("a dropped alias is a warning of the editor's validation, not an error", () => {
    const text = "providers:\n  openrouter:\n    models:\n      - { id: a/b, aliases: [deepseek/deepseek-v4.1-flash], price: { input_per_mtok: 1, output_per_mtok: 1 } }\n";
    const checked = validateConfigText("models", text);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.warnings).toHaveLength(1);
  });

  it("a change of the shipped file or of the user file reaches a process that refreshes its cache", () => {
    fs.writeFileSync(userFile(), "providers:\n  openrouter:\n    models:\n      - id: vendor/model-x\n        price: { input_per_mtok: 1, output_per_mtok: 2 }\n");
    expect(ids("openrouter")).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/model-x"]);
    // the shipped file gains a model (a product update): the user's overlay stays on top
    const doc = parseDocument(fs.readFileSync(shippedFile(), "utf8"));
    doc.addIn(["providers", "openrouter", "models"], doc.createNode({ id: "vendor/shipped-new", price: { input_per_mtok: 1, output_per_mtok: 1 } }));
    fs.writeFileSync(shippedFile(), doc.toString());
    expect(refreshConfigCache().changed).toContain("models");
    expect(ids("openrouter")).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/shipped-new", "vendor/model-x"]);
    // the user file changes: it is read again
    fs.writeFileSync(userFile(), "providers: {}\n");
    expect(refreshConfigCache().changed).toContain("models");
    expect(ids("openrouter")).toEqual(["deepseek/deepseek-v4.1-flash", "vendor/shipped-new"]);
  });

  it("config:check's inspection says how many models of a full copy the shipped file already has", () => {
    expect(inspectModelsOverlay()).toBeNull();
    fs.copyFileSync(shippedFile(), userFile());
    const inspection = inspectModelsOverlay();
    expect(inspection?.redundant).toBe(inspection?.total);
    expect(inspection?.total).toBeGreaterThan(5);
    fs.writeFileSync(userFile(), "providers:\n  openrouter:\n    models:\n      - id: vendor/model-x\n        price: { input_per_mtok: 1, output_per_mtok: 2 }\n");
    expect(inspectModelsOverlay()).toMatchObject({ redundant: 0, total: 1 });
  });
});
