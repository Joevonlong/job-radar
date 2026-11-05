import { readFileSync } from "node:fs";
import path from "node:path";
import { parseResume } from "../../../../src/lib/career/engine/render";

export const DAY = "2026-10-09";

export function fixture(name: string): string {
  return readFileSync(path.resolve(import.meta.dirname, "../../../fixtures/career", name), "utf8");
}

export function resumeFixture(name: string) {
  return parseResume(fixture(name));
}
