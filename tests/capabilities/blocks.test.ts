// @vitest-environment node
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import type { Permission } from "@/lib/agent-access/permissions";
import { blockList, blockShape, grantedBlocks, includeInput, loadBlocks, permittedBlocks, type FieldBlock } from "@/lib/capabilities/blocks";
import { defineCapability } from "@/lib/capabilities/types";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { defaultContext } from "@/lib/mcp/server";

const source = { id: 7 };
const valueSchema = z.strictObject({ value: z.string() });
const permissions = (...values: Permission[]) => new Set(values);
const context = () => defaultContext({} as Db, mcpSchema.parse({
  enabled: true,
  permissions: ["match:read", "notes:read"],
  stdio: { permissions: ["match:read", "notes:read"] },
}), { readSettings: () => { throw new Error("field blocks must use the authorization decision"); } });

function fixture() {
  const plainLoad = vi.fn(async (): Promise<unknown> => ({ value: "plain" }));
  const requestedLoad = vi.fn(async () => ({ value: "requested" }));
  const blocks: readonly FieldBlock<typeof source>[] = [
    { key: "plain", permission: "match:read", schema: valueSchema, onRequest: false, load: plainLoad },
    { key: "requested", permission: "notes:read", schema: valueSchema.nullable(), onRequest: true, load: requestedLoad },
  ];
  return { blocks, plainLoad, requestedLoad };
}

describe("field blocks", () => {
  it("keeps caller-specific schema output compatible with the capability's handler output", () => {
    const output = z.strictObject({ notices: z.array(z.string()), value: z.number() });
    type Definition = Parameters<typeof defineCapability<z.ZodObject, typeof output>>[0];
    type OutputFor = NonNullable<Definition["outputFor"]>;
    expectTypeOf(output).toExtend<ReturnType<OutputFor>>();
    expectTypeOf<z.output<ReturnType<OutputFor>>>().toEqualTypeOf<z.output<typeof output>>();
    expectTypeOf<() => z.ZodType<{ notices: string[]; value: string }>>().not.toExtend<OutputFor>();
  });

  it("permits only blocks whose permission is effective", () => {
    const { blocks } = fixture();
    expect(permittedBlocks(blocks, permissions("match:read"))).toEqual([blocks[0]]);
    expect(permittedBlocks(blocks, permissions())).toEqual([]);
  });

  it("grants automatic blocks and only the requested optional blocks, after checking permissions", () => {
    const { blocks } = fixture();
    const all = permissions("match:read", "notes:read");
    expect(grantedBlocks(blocks, all, undefined)).toEqual([blocks[0]]);
    expect(grantedBlocks(blocks, all, [])).toEqual([blocks[0]]);
    expect(grantedBlocks(blocks, all, ["requested"])).toEqual(blocks);
    expect(grantedBlocks(blocks, permissions("match:read"), ["requested"])).toEqual([blocks[0]]);
  });

  it("composes optional permitted keys and rejects every unpermitted block key", () => {
    const { blocks } = fixture();
    const schema = z.strictObject({ id: z.number(), ...blockShape(blocks, permissions("match:read")) });
    expect(schema.parse(source)).toEqual(source);
    expect(schema.parse({ ...source, plain: { value: "allowed" } })).toEqual({ ...source, plain: { value: "allowed" } });
    expect(schema.safeParse({ ...source, requested: null }).success).toBe(false);
    expect(z.strictObject(blockShape(blocks, permissions("notes:read"))).parse({ requested: null })).toEqual({ requested: null });
  });

  it("restricts include to a nonempty bounded array of on-request keys", () => {
    const { blocks } = fixture();
    const schema = includeInput(blocks, "Requested blocks");
    expect(schema.description).toBe("Requested blocks");
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse(["requested"])).toEqual(["requested"]);
    for (const input of [[], ["plain"], ["unknown"], ["requested", "requested"], "requested"]) {
      expect(schema.safeParse(input).success).toBe(false);
    }
    expect(() => includeInput(blocks.filter((block) => !block.onRequest), "Requested blocks")).toThrow();
    expect(() => includeInput([], "Requested blocks")).toThrow();
  });

  it("never loads an unpermitted block even when included", async () => {
    const { blocks, plainLoad, requestedLoad } = fixture();
    const ctx = { ...context(), permissions: permissions("match:read") };
    await expect(loadBlocks(blocks, ctx, source, ["requested"])).resolves.toEqual({ plain: { value: "plain" } });
    expect(plainLoad).toHaveBeenCalledWith(ctx, source);
    expect(requestedLoad).not.toHaveBeenCalled();
  });

  it("loads an on-request block only when included", async () => {
    const { blocks, requestedLoad } = fixture();
    const ctx = { ...context(), permissions: permissions("notes:read") };
    await expect(loadBlocks(blocks, ctx, source, undefined)).resolves.toEqual({});
    expect(requestedLoad).not.toHaveBeenCalled();
    await expect(loadBlocks(blocks, ctx, source, ["requested"])).resolves.toEqual({ requested: { value: "requested" } });
  });

  it("fails closed when the context has no permissions", async () => {
    const { blocks, plainLoad, requestedLoad } = fixture();
    await expect(loadBlocks(blocks, context(), source, ["plain", "requested"])).resolves.toEqual({});
    expect(plainLoad).not.toHaveBeenCalled();
    expect(requestedLoad).not.toHaveBeenCalled();
  });

  it("rejects fields outside a block's strict whitelist", async () => {
    const { blocks, plainLoad } = fixture();
    plainLoad.mockResolvedValue({ value: "allowed", secret: "private" });
    await expect(loadBlocks(blocks, { ...context(), permissions: permissions("match:read") }, source, undefined)).rejects.toThrow(z.ZodError);
  });

  it("loads granted blocks in parallel and parses their values", async () => {
    const started: string[] = [];
    let release: (value: unknown) => void = () => { throw new Error("the first loader did not start"); };
    const blocks: readonly FieldBlock<typeof source>[] = [
      { key: "first", permission: "jobs:read", schema: z.strictObject({ value: z.string().trim() }), onRequest: false, load: () => {
        started.push("first");
        return new Promise((resolve) => { release = resolve; });
      } },
      { key: "second", permission: "jobs:read", schema: valueSchema.nullable(), onRequest: false, load: async () => {
        started.push("second");
        release({ value: " trimmed " });
        return null;
      } },
    ];
    await expect(loadBlocks(blocks, { ...context(), permissions: permissions("jobs:read") }, source, undefined)).resolves.toEqual({ first: { value: "trimmed" }, second: null });
    expect(started).toEqual(["first", "second"]);
  });

  it("exposes only block metadata", () => {
    const { blocks } = fixture();
    expect(blockList(blocks)).toEqual([
      { key: "plain", permission: "match:read", onRequest: false },
      { key: "requested", permission: "notes:read", onRequest: true },
    ]);
  });
});
