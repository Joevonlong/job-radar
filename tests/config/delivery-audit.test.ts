// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { CHANNEL_KINDS } from "@/lib/channels/types";
import { withoutConfigVersion } from "@/lib/config/migrations/version";
import { deliveryAuditSchema } from "@/lib/config/schemas/delivery-audit";

import { REPO_DEFAULTS_DIR } from "./helpers";

/** Config versions belong to the loader; schemas validate the remaining required keys. */
function completeConfig(): Record<string, unknown> {
  return {
    scope: { channel_kinds: ["paid", "api"], exclude_channels: ["example-channel"] },
    checkpoint: { write_timeout_ms: 75 },
    retention: { days: 2, warn_bytes: 4096 },
    prune: { every_minutes: 3, batch_size: 7, statement_timeout_ms: 90 },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Include every object and leaf, treating an array as one required schema key. */
function keyPaths(value: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, child]) => {
    const current = [...prefix, key];
    return [current, ...(isObject(child) ? keyPaths(child, current) : [])];
  });
}

function objectAt(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  let current = value;
  for (const key of keys) {
    const next = current[key];
    if (!isObject(next)) throw new Error(`not an object: ${keys.join(".")}`);
    current = next;
  }
  return current;
}

const requiredPaths = keyPaths(completeConfig());
const objectPaths = [[], ...requiredPaths.filter((keys) => isObject(objectAt(completeConfig(), keys.slice(0, -1))[keys.at(-1)!]))];
const numberPaths = requiredPaths.filter((keys) => typeof objectAt(completeConfig(), keys.slice(0, -1))[keys.at(-1)!] === "number");

describe("delivery audit configuration", () => {
  it("accepts the shipped YAML without asserting its values", () => {
    const text = fs.readFileSync(path.join(REPO_DEFAULTS_DIR, "delivery-audit.yaml"), "utf8");
    const document: unknown = parse(text);
    expect(deliveryAuditSchema.safeParse(withoutConfigVersion(document)).success).toBe(true);
  });

  it("accepts a complete independently built configuration", () => {
    expect(deliveryAuditSchema.safeParse(completeConfig()).success).toBe(true);
  });

  it.each(requiredPaths.map((keys) => ({ keys, label: keys.join(".") })))("rejects missing $label", ({ keys }) => {
    const input = completeConfig();
    delete objectAt(input, keys.slice(0, -1))[keys.at(-1)!];
    expect(deliveryAuditSchema.safeParse(input).success).toBe(false);
  });

  it.each(objectPaths.map((keys) => ({ keys, label: keys.join(".") || "root" })))("rejects an unknown key at $label", ({ keys }) => {
    const input = completeConfig();
    objectAt(input, keys).unexpected_key = true;
    expect(deliveryAuditSchema.safeParse(input).success).toBe(false);
  });

  for (const value of [0, -1, 1.5]) {
    it.each(numberPaths.map((keys) => ({ keys, label: keys.join(".") })))(`rejects ${value} at $label`, ({ keys }) => {
      const input = completeConfig();
      objectAt(input, keys.slice(0, -1))[keys.at(-1)!] = value;
      expect(deliveryAuditSchema.safeParse(input).success).toBe(false);
    });
  }

  it("accepts every known channel kind and rejects an unknown kind", () => {
    const input = completeConfig();
    objectAt(input, ["scope"]).channel_kinds = [...CHANNEL_KINDS];
    expect(deliveryAuditSchema.safeParse(input).success).toBe(true);
    objectAt(input, ["scope"]).channel_kinds = ["unknown-provider"];
    expect(deliveryAuditSchema.safeParse(input).success).toBe(false);
  });
});
