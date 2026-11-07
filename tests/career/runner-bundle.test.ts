// @vitest-environment node
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps rendering and printing out of the runner bundle", async () => {
  const result = await build({ entryPoints: ["src/runner/index.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false, metafile: true, external: ["playwright-core"], logLevel: "silent" });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs).toContain("src/lib/career/extract/handler.ts");
  expect(inputs).toContain("src/lib/career/tailor/handler.ts");
  expect(inputs.filter((file) => /src\/lib\/career\/(?:engine|print)\//.test(file))).toEqual([]);
});
