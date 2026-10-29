import { describe, expect, it } from "vitest";

import { OVERLAY_RECORD_RULES } from "@/lib/config/overlay-rules";
import { configRegistry, LAYERED_CONFIG_NAMES } from "@/lib/config/registry";

/** The parts of a zod 4 schema definition the walk looks at. */
interface SchemaNode {
  _zod: { def: SchemaDef };
}
interface SchemaDef {
  type: string;
  shape?: Record<string, SchemaNode>;
  valueType?: SchemaNode;
  element?: SchemaNode;
  innerType?: SchemaNode;
  in?: SchemaNode;
  out?: SchemaNode;
  options?: readonly SchemaNode[];
  left?: SchemaNode;
  right?: SchemaNode;
  items?: readonly SchemaNode[];
  rest?: SchemaNode | null;
  getter?: () => SchemaNode;
}

const WRAPPERS = new Set(["optional", "nullable", "default", "prefault", "readonly", "catch", "nonoptional", "success"]);
const LEAVES = new Set(["string", "number", "int", "boolean", "bigint", "enum", "literal", "unknown", "any", "null", "undefined", "date", "nan", "never", "void", "symbol", "custom", "template_literal", "file"]);

/** Every record path of a schema: dotted keys, `*` = a record's values, `[]` = a list's items. */
function recordPaths(schema: SchemaNode): string[] {
  const found = new Set<string>();
  const seen = new Set<SchemaNode>();
  const walk = (node: SchemaNode, path: string[]): void => {
    const def = node._zod.def;
    if (WRAPPERS.has(def.type) && def.innerType) return walk(def.innerType, path);
    switch (def.type) {
      case "object":
        for (const [key, child] of Object.entries(def.shape ?? {})) walk(child, [...path, key]);
        return;
      case "record":
        found.add(path.join("."));
        if (def.valueType) walk(def.valueType, [...path, "*"]);
        return;
      case "array":
      case "set":
        if (def.element) walk(def.element, [...path, "[]"]);
        return;
      case "tuple":
        for (const item of [...(def.items ?? []), ...(def.rest ? [def.rest] : [])]) walk(item, [...path, "[]"]);
        return;
      case "pipe":
        if (def.in) walk(def.in, path);
        return;
      case "union":
        for (const option of def.options ?? []) walk(option, path);
        return;
      case "intersection":
        if (def.left) walk(def.left, path);
        if (def.right) walk(def.right, path);
        return;
      case "lazy":
        if (seen.has(node) || !def.getter) return;
        seen.add(node);
        walk(def.getter(), path);
        return;
      default:
        // a type the walk does not know could hide a record: fail rather than pass silently
        if (!LEAVES.has(def.type)) throw new Error(`record-coverage: unknown zod type "${def.type}" at ${path.join(".") || "(root)"}`);
    }
  };
  walk(schema, []);
  return [...found].sort();
}

function matches(rule: string, path: string): boolean {
  const a = rule.split(".");
  const b = path.split(".");
  return a.length === b.length && a.every((segment, index) => segment === b[index] || (segment === "*" && b[index] !== "[]"));
}

describe("every record of the layered schemas is registered in overlay-rules.ts", () => {
  const cases = LAYERED_CONFIG_NAMES.map((name) => ({ name, paths: recordPaths(configRegistry[name].schema as unknown as SchemaNode) }));

  it.each(cases)("$name", ({ name, paths }) => {
    const rules = OVERLAY_RECORD_RULES[name] ?? [];
    const unregistered = paths.filter((path) => !rules.some((rule) => matches(rule.path, path)));
    expect(unregistered, `register these records of ${configRegistry[name].file} in OVERLAY_RECORD_RULES`).toEqual([]);
    const stale = rules.filter((rule) => !paths.some((path) => matches(rule.path, path))).map((rule) => rule.path);
    expect(stale, `these rules of ${configRegistry[name].file} match no record`).toEqual([]);
    for (const rule of rules) expect(rule.kind === "in-array", rule.path).toBe(rule.path.includes("[]"));
  });

  it("covers no config that is not layered", () => {
    for (const name of Object.keys(OVERLAY_RECORD_RULES)) expect(LAYERED_CONFIG_NAMES).toContain(name);
  });
});
