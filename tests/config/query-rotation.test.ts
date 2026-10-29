// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import { z } from "zod";

import { hashConfigText, loadConfig, readConfigText, reloadConfig } from "@/lib/config";
import { configToDraft } from "@/lib/settings/draft";
import { saveSettings } from "@/lib/settings/service";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

function writeCollect(value: unknown): void {
  const file = path.join(tmp.configDir, "sources.yaml");
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  if (value === undefined) doc.delete("collect");
  else doc.set("collect", doc.createNode(value));
  fs.writeFileSync(file, doc.toString());
}

describe("query rotation configuration compatibility", () => {
  it.each([undefined, { concurrency: 2 }])("loads a full old user file with collect=%j and defaults rotation on", (collect) => {
    writeCollect(collect);
    expect(loadConfig("channels").collect).toMatchObject({ concurrency: collect?.concurrency ?? 3, query_rotation: true });
  });

  it("can opt out, and rejects misspelled keys or a non-boolean", () => {
    writeCollect({ concurrency: 2, query_rotation: false });
    expect(loadConfig("channels").collect.query_rotation).toBe(false);
    for (const collect of [{ concurrency: 2, query_rotation: "false" }, { concurrency: 2, query_rotations: false }]) {
      writeCollect(collect);
      expect(() => reloadConfig("channels")).toThrow();
    }
  });

  it.each([undefined, true, false])("saves the sources settings and reloads without injecting or losing rotation=%s", async (rotation) => {
    writeCollect({ concurrency: 2, ...(rotation === undefined ? {} : { query_rotation: rotation }) });
    const draft = configToDraft("channels", loadConfig("channels"));
    draft["collect.concurrency"] = "4";
    const result = await saveSettings({ tab: "channels", draft, baseHash: hashConfigText(readConfigText("channels")) });
    expect(result.status).toBe("saved");
    expect(reloadConfig("channels").collect).toMatchObject({ concurrency: 4, query_rotation: rotation ?? true });
    const saved = parse(readConfigText("channels")) as { collect: Record<string, unknown> };
    expect(saved.collect.query_rotation).toBe(rotation);
  });

  it("only needs the new key removed for the old strict collect schema to accept the user file", () => {
    const oldCollect = z.strictObject({ concurrency: z.number().int().positive().default(3) }).default({ concurrency: 3 });
    writeCollect({ concurrency: 2, query_rotation: false });
    const doc = parseDocument(readConfigText("channels"));
    expect(oldCollect.safeParse((parse(doc.toString()) as { collect?: unknown }).collect).success).toBe(false);
    doc.deleteIn(["collect", "query_rotation"]);
    expect(oldCollect.parse((parse(doc.toString()) as { collect?: unknown }).collect)).toEqual({ concurrency: 2 });
    doc.delete("collect");
    expect(oldCollect.parse(doc.get("collect"))).toEqual({ concurrency: 3 });
  });
});
