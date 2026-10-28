// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { authFileIn, tempDir } from "./helpers";

it("cleans session and nested auth fixtures after the test", () => {
  const created: string[] = [];
  onTestFinished(() => {
    try {
      for (const dir of created) expect(fs.existsSync(dir), `${dir} should be removed at the test boundary`).toBe(false);
    } finally {
      // Also clean up when verifying the regression against the old helper.
      for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const dir = tempDir();
  created.push(dir);
  fs.writeFileSync(path.join(dir, "fixture"), "temporary");
  const auth = authFileIn();
  created.push(path.dirname(path.dirname(auth)));
  expect(fs.existsSync(auth)).toBe(true);
});
