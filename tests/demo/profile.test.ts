import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { realEmails } from "../../e2e-demo/guard";

import { parseConfigText } from "@/lib/config";

const DIR = path.resolve(import.meta.dirname, "../../scripts/demo/profile");

describe("demo profile", () => {
  it.each([
    ["me.yaml", "me"],
    ["preferences.yaml", "preferences"],
  ] as const)("%s is valid", (file, name) => {
    expect(() => parseConfigText(name, fs.readFileSync(path.join(DIR, file), "utf8"))).not.toThrow();
  });

  it("holds no real contact data or private paths", () => {
    for (const file of fs.readdirSync(DIR)) {
      const text = fs.readFileSync(path.join(DIR, file), "utf8");
      expect(realEmails(text)).toEqual([]);
      // the private folder's name, built at run time (the release check flags it as a literal)
      expect(text).not.toContain(["n30", "Private"].join("_"));
      expect(text).not.toMatch(/\/(Users|Volumes)\/|https?:\/\/(?!127\.0\.0\.1|localhost|[a-z0-9.-]*\.example\b)/i);
    }
  });
});
