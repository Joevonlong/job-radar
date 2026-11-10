// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

function engineCodes(): string[] {
  const directory = path.resolve("src/lib/career/engine");
  const codes = new Set<string>();
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "fonts.generated.ts") continue;
    const file = path.join(entry.parentPath, entry.name);
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^career\.[a-z]+\.[a-z0-9_]+$/.test(node.text))
        codes.add(node.text.replace(/^career\./, ""));
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...codes].sort();
}

function flatten(value: object, prefix = ""): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[full, child]] : Object.entries(flatten(child, full));
  }));
}

it("translates every engine diagnostic literal in both locales, including future additions", () => {
  const codes = engineCodes();
  expect(codes.length).toBeGreaterThan(0);
  for (const catalog of [en, zh]) {
    const messages = flatten(catalog.career.documents.checks);
    expect(Object.keys(messages).sort()).toEqual(codes);
    for (const code of codes) expect(messages[code]?.trim(), code).toBeTruthy();
  }
  const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  const english = flatten(en.career.documents.checks);
  const chinese = flatten(zh.career.documents.checks);
  for (const code of codes) expect(params(english[code]!)).toEqual(params(chinese[code]!));
  expect(Object.keys(english)).toEqual(Object.keys(chinese));
});
