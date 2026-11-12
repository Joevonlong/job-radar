// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse } from "yaml";
import { z } from "zod";
import { expect, it } from "vitest";
import { CHANNEL_CONFIG_TABLE } from "@/lib/channels/config-table";
import { DOCTOR_IDS } from "@/lib/mcp/dto/ops";

it("allows every literal and built-in template id emitted by the doctor checks", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const directory = path.join(root, "src/lib/ops/doctor/checks");
  const compose = z.object({ services: z.record(z.string(), z.unknown()) }).parse(parse(fs.readFileSync(path.join(root, "compose.yaml"), "utf8")));
  const templates: Record<string, string[]> = {
    "`channels.${card.id}`": Object.keys(CHANNEL_CONFIG_TABLE).map((id) => `channels.${id}`),
    "`compose.${service}`": Object.keys(compose.services).map((service) => `compose.${service}`),
  };
  const emitted = new Set<string>();
  const seenTemplates = new Set<string>();
  for (const file of fs.readdirSync(directory).filter((file) => file.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(directory, file), "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === "id" && node.parent.properties.some((property) => property.name?.getText(source) === "group")) {
        throw new Error(`Computed doctor id in ${file} needs a deterministic expansion`);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") === "id") {
        const value = node.initializer;
        if (ts.isStringLiteralLike(value)) emitted.add(value.text);
        else if (ts.isTemplateExpression(value)) {
          const template = value.getText(source);
          expect(Object.hasOwn(templates, template), `Unrecognized doctor id template in ${file}: ${template}`).toBe(true);
          seenTemplates.add(template);
          for (const id of templates[template]!) emitted.add(id);
        } else if (ts.isObjectLiteralExpression(node.parent) && node.parent.properties.some((property) => property.name?.getText(source) === "group")) {
          expect(`${file}:${value.getText(source)}`, "New computed check ids need a deterministic expansion").toBe("data.ts:input.id");
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect([...seenTemplates].sort()).toEqual(Object.keys(templates).sort());
  expect(emitted.size).toBeGreaterThan(0);
  expect([...emitted].filter((id) => !DOCTOR_IDS.includes(id))).toEqual([]);
});
