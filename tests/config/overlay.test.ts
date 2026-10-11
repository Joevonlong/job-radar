// @vitest-environment node
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { pruneRedundantKeys } from "@/lib/config/overlay";

const schema = z.strictObject({
  name: z.string(),
  limit: z.number().default(10),
  backup: z.strictObject({ enabled: z.boolean().default(true), keep: z.number().default(7) }).default({ enabled: true, keep: 7 }),
  tasks: z.strictObject({ a: z.strictObject({ order: z.array(z.string()).default(["x"]) }).default({ order: ["x"] }) }).default({ a: { order: ["x"] } }),
  tags: z.array(z.string()).default([]),
});

const parse = (value: unknown) => schema.parse(value);

describe("pruneRedundantKeys", () => {
  it("drops keys the file did not have that hold the schema default", () => {
    const value = parse({ name: "n" });
    expect(value.backup.keep).toBe(7);
    expect(pruneRedundantKeys(schema, value, { name: "n" })).toEqual({ name: "n" });
  });

  it("keeps a new key whose value differs from the default", () => {
    const value = parse({ name: "n", limit: 20 });
    expect(pruneRedundantKeys(schema, value, { name: "n" })).toEqual({ name: "n", limit: 20 });
  });

  it("keeps keys the file already had, even when they equal the default", () => {
    const value = parse({ name: "n", limit: 10, backup: { enabled: true } });
    const existing = { name: "n", limit: 10, backup: { enabled: true } };
    expect(pruneRedundantKeys(schema, value, existing)).toEqual({ name: "n", limit: 10, backup: { enabled: true } });
  });

  it("prunes inside a map the file has, keeping only what differs from the default", () => {
    const value = parse({ name: "n", backup: { enabled: false, keep: 7 } });
    expect(pruneRedundantKeys(schema, value, { name: "n", backup: { enabled: true } })).toEqual({ name: "n", backup: { enabled: false } });
  });

  it("keeps only the differing leaf of a new nested map", () => {
    const value = parse({ name: "n", tasks: { a: { order: ["y"] } }, backup: { keep: 3 } });
    expect(pruneRedundantKeys(schema, value, { name: "n" })).toEqual({ name: "n", tasks: { a: { order: ["y"] } }, backup: { keep: 3 } });
  });

  it("treats lists as a whole and never changes the validated result", () => {
    const value = parse({ name: "n", tags: ["a"] });
    const pruned = pruneRedundantKeys(schema, value, { name: "n" });
    expect(pruned).toEqual({ name: "n", tags: ["a"] });
    expect(parse(pruned)).toEqual(value);
  });

  it("does not touch the input", () => {
    const value = parse({ name: "n" });
    const copy = structuredClone(value);
    pruneRedundantKeys(schema, value, { name: "n" });
    expect(value).toEqual(copy);
  });
});
