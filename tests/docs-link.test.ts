import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import pkg from "../package.json";
import { DEFAULT_SOURCE_URL, DOC_LINKS, docsUrl, SOURCE_URL, sourceRefFor, type DocKey } from "@/lib/docs-link";

/** The slug GitHub gives a heading: lower-case, spaces to dashes, punctuation dropped (letters of any script stay). */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headings(file: string): string[] {
  const text = fs.readFileSync(path.resolve(import.meta.dirname, "../docs", file), "utf8");
  return text
    .split("\n")
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => slug(l.replace(/^#{1,6}\s+/, "")));
}

describe("docs links of the interface", () => {
  it("points at the guide on GitHub, in the language of the interface", () => {
    expect(DEFAULT_SOURCE_URL).toBe(pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
    expect(SOURCE_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    expect(docsUrl("en", "scraping", "v2.0.0")).toBe(`${SOURCE_URL}/blob/v2.0.0/docs/sources.md#scraping`);
    expect(docsUrl("zh", "scraping", "v2.0.0")).toBe(`${SOURCE_URL}/blob/v2.0.0/docs/sources.zh.md#抓取`);
    // a language without its own guide reads the English one
    expect(docsUrl("de", "aiProviders", "v2.0.0")).toBe(`${SOURCE_URL}/blob/v2.0.0/docs/ai-providers.md#which-providers-receive-job-text`);
    // without Next (no NEXT_PUBLIC_SOURCE_REF) the links fall back to main
    expect(docsUrl("en", "scraping")).toBe(`${SOURCE_URL}/blob/main/docs/sources.md#scraping`);
  });

  it("the web build points the links at the tag of the running version", () => {
    expect(sourceRefFor(pkg.version)).toBe(`v${pkg.version}`);
    const nextConfig = fs.readFileSync(path.resolve(import.meta.dirname, "../next.config.ts"), "utf8");
    expect(nextConfig).toContain("NEXT_PUBLIC_SOURCE_REF: sourceRefFor(pkg.version)");
    expect(nextConfig).toContain("poweredByHeader: false");
  });

  it.each(Object.keys(DOC_LINKS) as DocKey[])("%s: the file and the heading exist in English and Chinese", (key) => {
    const doc = DOC_LINKS[key];
    expect(headings(`${doc.file}.md`)).toContain(doc.anchor.en);
    expect(headings(`${doc.file}.zh.md`)).toContain(doc.anchor.zh);
  });
});
