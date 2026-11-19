// @vitest-environment node
import { createCipheriv, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeSyncCursor, encodeSyncCursor, type CursorKey, type CursorScope, type SyncCursor } from "@/lib/capabilities/sync/cursor";
import { SYNC_DTO_VERSION } from "@/lib/db/sync-sources";

const key: CursorKey = { keyId: randomUUID(), cursorKey: Buffer.alloc(32, 13) };
const scope: CursorScope = {
  tool: "list_job_changes", blocks: ["job", "match"], permissions: ["jobs:read", "match:read"], dtoVersion: SYNC_DTO_VERSION,
};
const generation = randomUUID();
const tx = "18446744073709551600";
const seq = "9223372036854775800";
const cursor: Extract<SyncCursor, { phase: "changes" }> = {
  ...scope, v: 1, phase: "changes", generation,
  position: { consumed: { tx, seq }, active: { row: { tx, seq: "9223372036854775801" }, after: { jobId: 2, kind: "job" } } },
};

describe("sync cursors", () => {
  it("round-trips both positions with the documented envelope and hides the log position", () => {
    const encoded = encodeSyncCursor(key, cursor);
    expect(decodeSyncCursor(encoded, key, scope)).toEqual(cursor);
    const bytes = Buffer.from(encoded, "base64url");
    expect(bytes.subarray(0, 16)).toEqual(Buffer.from(key.keyId.replaceAll("-", ""), "hex"));
    expect(bytes.includes(Buffer.from(tx))).toBe(false);
    expect(bytes.includes(Buffer.from(seq))).toBe(false);
    expect(encodeSyncCursor(key, cursor)).not.toBe(encoded);
    const snapshot = { ...scope, v: 1, phase: "snapshot", generation, position: { start: { tx, seq: "0" }, after: { kind: "job", jobId: 2 } } } as const;
    const current = { ...snapshot, blocks: scope.blocks, permissions: scope.permissions };
    expect(decodeSyncCursor(encodeSyncCursor(key, current), key, scope)).toEqual(current);
  });

  it("rejects an altered ciphertext or a malformed encoding", () => {
    const encoded = encodeSyncCursor(key, cursor);
    const bytes = Buffer.from(encoded, "base64url");
    bytes[29] ^= 1;
    expect(() => decodeSyncCursor(bytes.toString("base64url"), key, scope)).toThrow("invalid_cursor");
    expect(() => decodeSyncCursor(encoded + "=", key, scope)).toThrow("invalid_cursor");
    expect(() => decodeSyncCursor("x", key, scope)).toThrow("invalid_cursor");
  });

  it("treats the wrong key id as a reset and authenticates the key id as additional data", () => {
    const encoded = encodeSyncCursor(key, cursor);
    const rotated = { ...key, keyId: randomUUID() };
    expect(() => decodeSyncCursor(encoded, rotated, scope)).toThrow("log_reset");
    const bytes = Buffer.from(encoded, "base64url");
    Buffer.from(rotated.keyId.replaceAll("-", ""), "hex").copy(bytes);
    expect(() => decodeSyncCursor(bytes.toString("base64url"), rotated, scope)).toThrow("invalid_cursor");
  });

  it.each([
    { ...scope, tool: "list_application_changes" },
    { ...scope, blocks: ["job", "salary"] },
    { ...scope, permissions: ["jobs:read"] },
    { ...scope, dtoVersion: SYNC_DTO_VERSION + 1 },
  ] satisfies CursorScope[])("rejects a changed scope %#", (different) => {
    expect(() => decodeSyncCursor(encodeSyncCursor(key, cursor), key, different)).toThrow("scope_changed");
  });

  it("rejects authenticated payloads with invalid positions", () => {
    const invalid = { ...cursor, position: { consumed: { tx: "no number", seq }, active: cursor.position.active } };
    const id = Buffer.from(key.keyId.replaceAll("-", ""), "hex");
    const nonce = Buffer.alloc(12);
    const cipher = createCipheriv("aes-256-gcm", key.cursorKey, nonce);
    cipher.setAAD(id);
    const token = Buffer.concat([id, nonce, cipher.update(JSON.stringify(invalid)), cipher.final(), cipher.getAuthTag()]).toString("base64url");
    expect(() => decodeSyncCursor(token, key, scope)).toThrow("invalid_cursor");
    const reversed = { ...cursor, position: { ...cursor.position, active: { ...cursor.position.active!, row: { tx, seq: "1" } } } };
    expect(() => decodeSyncCursor(encodeSyncCursor(key, reversed), key, scope)).toThrow("invalid_cursor");
  });
});
