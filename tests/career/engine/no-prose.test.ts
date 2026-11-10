// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../src/lib/career/engine");
const FILES = fs.readdirSync(ROOT, { recursive: true }).filter((file): file is string => typeof file === "string" && file.endsWith(".ts")).map((file) => path.join(ROOT, file));
const program = ts.createProgram(FILES, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, strict: true });
const checker = program.getTypeChecker();

function codeType(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.every(codeType);
  if (type.isStringLiteral()) return /^career\.[a-z]+\.[a-z0-9_]+$/.test(type.value);
  return !!(type.flags & ts.TypeFlags.TemplateLiteral) && /^career\.[a-z]+\.$/.test((type as ts.TemplateLiteralType).texts[0]);
}

const CHECK_ARGUMENT = new Map([
  ...["regex", "min", "max", "length", "size", "gt", "gte", "lt", "lte", "multipleOf", "step", "startsWith", "endsWith", "includes", "refine", "custom"].map((name): [string, number] => [name, 1]),
  ...["nonempty", "email", "url", "uuid", "guid", "cuid", "cuid2", "ulid", "nanoid", "base64", "base64url", "hex", "hostname", "jwt", "emoji", "lowercase", "uppercase", "datetime", "date", "time", "duration", "ip", "ipv4", "ipv6", "cidrv4", "cidrv6", "int", "integer", "positive", "negative", "nonnegative", "nonpositive", "finite", "safe", "check"].map((name): [string, number] => [name, 0]),
]);

function scan(file: string, source: ts.SourceFile, types?: ts.TypeChecker): string[] {
  // Generated font metadata contains family names, not diagnostic or interface prose.
  if (file === "fonts.generated.ts") return [];
  const out: string[] = [];
  const literal = (node: ts.Node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
  const isCode = (node: ts.Node) => (literal(node) && /^career\.[a-z]+\.[a-z0-9_]+$/.test(node.text)) || !!(types && codeType(types.getTypeAtLocation(node)));
  const propertyName = (name: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
    return undefined;
  };
  const zodCheck = (node: ts.CallExpression) => {
    if (!ts.isPropertyAccessExpression(node.expression) || !CHECK_ARGUMENT.has(node.expression.name.text)) return false;
    let receiver: ts.Expression = node.expression.expression;
    const schema = !!types?.getTypeAtLocation(receiver).getProperty("_zod");
    while (ts.isCallExpression(receiver) || ts.isPropertyAccessExpression(receiver)) receiver = ts.isCallExpression(receiver) ? receiver.expression : receiver.expression;
    return schema || (ts.isIdentifier(receiver) && receiver.text === "z");
  };
  const add = (rule: string, node: ts.Node) => out.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${rule}`);
  function visit(node: ts.Node) {
    if (ts.isLiteralTypeNode(node) || ts.isTemplateLiteralTypeNode(node)) return;
    if (ts.isThrowStatement(node)) {
      const value = node.expression;
      const engineError = ts.isNewExpression(value) && value.expression.getText(source) === "CareerEngineError";
      const unreachable = file === "schema.ts" && value.getText(source) === 'new Error("unreachable")';
      if (!engineError && !unreachable) add("throw", node);
    }
    if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propertyName(node.name) === "message") {
      const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
      const object = node.parent;
      const call = object.parent;
      const issue = ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "addIssue";
      const option = ts.isCallExpression(call) && zodCheck(call);
      if (!(issue || option) || !isCode(value)) add("message", node);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && zodCheck(node)) {
      const start = CHECK_ARGUMENT.get(node.expression.name.text)!;
      for (const arg of node.arguments.slice(start)) if (literal(arg) && !isCode(arg)) add("zod", arg);
    }
    if (literal(node)) {
      if (node.text.startsWith("career.") && !/^career\.[a-z]+\.[a-z0-9_]+$/.test(node.text)) add("code", node);
      const text = node.text.replace(/<\/?[a-z!][^>]*(?:>|$)/gi, "").replace(/^["']?\s*>/, "");
      if (/[A-Za-z]+ [A-Za-z]+/.test(text) && file !== "i18n.ts" && !file.startsWith("themes/")) add("prose", node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

const inline = (code: string, file = "probe.ts") => scan(file, ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true));

test("engine diagnostics contain codes and data after stripping markup", () => {
  expect(FILES.flatMap((file) => scan(path.relative(ROOT, file).replaceAll(path.sep, "/"), program.getSourceFile(file)!, checker))).toEqual([]);
});

test.each([
  ['throw new Error("bad")', "throw"],
  ['throw failure', "throw"],
  ['const x = { message: "some prose" }', "message"],
  ['ctx.addIssue({ code: "custom", message: "some prose" })', "message"],
  ['z.string().regex(/x/, "some prose")', "zod"],
  ['z.string().min(1, { message: "some prose" })', "message"],
  ['z.string().refine(Boolean, "some prose")', "zod"],
  ['logger.error({ message: "career.check.failed" })', "message"],
  ['z.number().nonnegative("invalid")', "zod"],
  ['z.string().startsWith("x", "invalid")', "zod"],
  ['ctx.addIssue({ code: "custom", ["message"]: "invalid" })', "message"],
  ['const x = "some prose"', "prose"],
  ['const x = "<p class=\\"a\\">some prose</p>"', "prose"],
  ['const x = "count < 3 and some prose"', "prose"],
  ['const x = `some prose ${value} more words`', "prose"],
  ['const x = "career.naming.not-valid"', "code"],
])("scanner rejects %s", (code, rule) => {
  expect(inline(code).some((problem) => problem.endsWith(`: ${rule}`))).toBe(true);
});

test.each([
  'const x = "<p class=\\"a\\">"',
  'const x = "<a href=\\""',
  'const x = "\\">\\n<head>\\n<meta charset=\\"utf-8\\">"',
])("scanner accepts markup %s", (code) => {
  expect(inline(code)).toEqual([]);
});

test("exceptions are narrow: literal types, document labels, theme templates, schema assertion", () => {
  expect(inline('type Family = "IBM Plex Sans"')).toEqual([]);
  expect(inline('const family = "IBM Plex Sans"', "fonts.generated.ts")).toEqual([]);
  expect(inline('const family = "IBM Plex Sans"', "other.generated.ts")).not.toEqual([]);
  expect(inline('const x = "some prose"', "i18n.ts")).toEqual([]);
  expect(inline('const x = "some prose"', "themes/minimal/template.ts")).toEqual([]);
  expect(inline('throw new Error("unreachable")', "schema.ts")).toEqual([]);
  expect(inline('throw new Error("unreachable")')).not.toEqual([]);
  expect(inline('const x = "some prose"', "naming.ts")).not.toEqual([]);
  expect(inline('const x = "career.naming.not-valid"', "naming.ts")).not.toEqual([]);
  expect(inline('throw new CareerEngineError("career.schema.invalid")')).toEqual([]);
  expect(inline('ctx.addIssue({ code: "custom", message: "career.schema.invalid" })')).toEqual([]);
  expect(inline('z.string().regex(/x/, "career.schema.invalid")')).toEqual([]);
  expect(inline('z.string().startsWith("hello world", "career.schema.invalid")', "i18n.ts")).toEqual([]);
  expect(inline('z.string().startsWith("x", "career.schema.invalid")')).toEqual([]);
  expect(inline('z.string().min(1, { message: "career.schema.invalid" })')).toEqual([]);
});
