import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

import { compareChangePositions } from "@/lib/db/sync-position";
import { SYNC_BLOCKS, type SyncBlock } from "@/lib/db/sync-sources";

const VERSION = 1;
const ID_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

const decimal = (max: bigint) => z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .pipe(z.string().refine((value) => BigInt(value) <= max));
const positionSchema = z.strictObject({ tx: decimal(2n ** 64n - 1n), seq: decimal(2n ** 63n - 1n) });
const keySchema = z.strictObject({ jobId: z.int().positive(), kind: z.enum(["job", "application", "favorite"]) });
export const SYNC_TOOLS = ["list_job_changes", "list_application_changes"] as const;

const scopeShape = {
  tool: z.enum(SYNC_TOOLS),
  blocks: z.array(z.enum(Object.keys(SYNC_BLOCKS) as SyncBlock[])),
  permissions: z.array(z.enum(["jobs:read", "tracking:read", "match:read", "notes:read"])),
  dtoVersion: z.int().positive(),
};
const scopeSchema = z.strictObject(scopeShape);
const common = { v: z.literal(VERSION), ...scopeSchema.shape, generation: z.uuid() };
const cursorSchema = z.discriminatedUnion("phase", [
  z.strictObject({
    ...common,
    phase: z.literal("snapshot"),
    position: z.strictObject({ start: positionSchema.extend({ seq: z.literal("0") }), after: keySchema.nullable() }),
  }),
  z.strictObject({
    ...common,
    phase: z.literal("changes"),
    position: z.strictObject({
      consumed: positionSchema,
      active: z.strictObject({ row: positionSchema, after: keySchema }).nullable(),
    }),
  }),
]);

export type CursorScope = z.infer<typeof scopeSchema>;
export type SyncCursor = z.infer<typeof cursorSchema>;
export type CursorKey = { keyId: string; cursorKey: Buffer };

export class SyncCursorError extends Error {
  constructor(readonly reason: "invalid_cursor" | "log_reset" | "scope_changed") {
    super(reason);
  }
}

function keyIdBytes(key: CursorKey): Buffer {
  return Buffer.from(key.keyId.replaceAll("-", ""), "hex");
}

export function encodeSyncCursor(key: CursorKey, cursor: Omit<Extract<SyncCursor, { phase: "snapshot" }>, "v"> | Omit<Extract<SyncCursor, { phase: "changes" }>, "v">): string {
  const keyId = keyIdBytes(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.cursorKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(keyId);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ ...cursor, v: VERSION }), "utf8"), cipher.final()]);
  return Buffer.concat([keyId, nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

export function decodeSyncCursor(value: string, key: CursorKey, scope: CursorScope): SyncCursor {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length <= ID_BYTES + NONCE_BYTES + TAG_BYTES || bytes.toString("base64url") !== value) {
    throw new SyncCursorError("invalid_cursor");
  }
  const keyId = bytes.subarray(0, ID_BYTES);
  if (!keyId.equals(keyIdBytes(key))) throw new SyncCursorError("log_reset");

  let json: unknown;
  try {
    const decipher = createDecipheriv(ALGORITHM, key.cursorKey, bytes.subarray(ID_BYTES, ID_BYTES + NONCE_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(keyId);
    decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
    const plaintext = Buffer.concat([decipher.update(bytes.subarray(ID_BYTES + NONCE_BYTES, -TAG_BYTES)), decipher.final()]);
    json = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new SyncCursorError("invalid_cursor");
  }

  const parsed = cursorSchema.safeParse(json);
  if (!parsed.success) throw new SyncCursorError("invalid_cursor");
  const cursor = parsed.data;
  if (cursor.phase === "changes" && cursor.position.active !== null &&
    compareChangePositions(cursor.position.active.row, cursor.position.consumed) <= 0) throw new SyncCursorError("invalid_cursor");
  if (cursor.tool !== scope.tool || cursor.dtoVersion !== scope.dtoVersion ||
    !sameValues(cursor.blocks, scope.blocks) || !sameValues(cursor.permissions, scope.permissions)) {
    throw new SyncCursorError("scope_changed");
  }
  return cursor;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
