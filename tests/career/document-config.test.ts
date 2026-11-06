import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { CAREER_DENSITIES, CAREER_LANGS, CAREER_PAPERS, CAREER_THEMES, careerSchema } from "@/lib/config/schemas/career";
import { listThemes } from "@/lib/career/engine/render";
import { Resume } from "@/lib/career/engine/schema";
import { BUILTINS } from "@/lib/career/engine/sections";
import { DOCUMENT_BUILTINS } from "@/lib/career/schema/document";
import { preferencesSchema } from "@/lib/career/schema/preferences";
import { loadPreferences } from "@/lib/career/store/preferences";
import { careerDir } from "@/lib/career/store/paths";
import { tempCareer } from "./fixtures";
import { defaults } from "./document-fixtures";

let temp: ReturnType<typeof tempCareer> | undefined;
afterEach(() => temp?.cleanup());
it("keeps core config enums synchronized with the engine", () => {
  expect(CAREER_THEMES).toEqual(listThemes());
  const meta = Resume.shape.meta.unwrap().shape;
  expect(CAREER_LANGS).toEqual(meta.lang.unwrap().options);
  expect(CAREER_PAPERS).toEqual(meta.paper.unwrap().options);
  expect(CAREER_DENSITIES).toEqual(meta.density.unwrap().options);
  expect(DOCUMENT_BUILTINS).toEqual(BUILTINS);
});
it("keeps old overlays valid and validates the document and preview bounds", () => {
  expect(careerSchema.safeParse({ enabled: false }).success).toBe(true);
  for (const raw of [
    { document: { max_documents: 0 } }, { document: { max_documents: 1001 } },
    { document: { image_max_bytes: 20000001 } }, { document: { max_request_bytes: 50000001 } },
    { document: { defaults: { lang: "zh" } } }, { document: { defaults: { extra: "bad" } } },
    { preview: { debounce_ms: 49 } }, { preview: { debounce_ms: 10001 } },
  ]) expect(careerSchema.safeParse(raw).success).toBe(false);
});
it("builds missing preferences from the effective career defaults without writing files", async () => {
  temp = tempCareer({ document: { defaults: defaults() } });
  expect(await loadPreferences()).toEqual({ preferences: { schema_version: 1, layout: defaults(), emphasis: null, tone: null }, baseHash: null });
  expect(fs.existsSync(careerDir())).toBe(false);
  expect(preferencesSchema.safeParse({ schema_version: 1, layout: { ...defaults(), extra: "bad" }, emphasis: null, tone: null }).success).toBe(false);
  expect(preferencesSchema.safeParse({ schema_version: 1, layout: defaults(), emphasis: "x".repeat(20001), tone: null }).success).toBe(false);
});
