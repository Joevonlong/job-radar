// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { mcpSchema } from "@/lib/config/schemas/mcp";
import { createConnection, QUERY_SESSION_SETTINGS } from "@/lib/db/client";
import { closeMcpPools, getMcpAuditRecorder, getMcpReadDb, getMcpWriteDb, openMcpAuditConnection } from "@/lib/db/mcp-pools";

vi.mock("@/lib/db/client", () => ({
  QUERY_SESSION_SETTINGS: { jit: "off" },
  createConnection: vi.fn(() => ({ db: {}, sql: { end: vi.fn(async () => {}) } })),
}));
vi.mock("@/lib/env", () => ({ loadDatabaseEnv: () => ({ DATABASE_URL: "postgres://unreachable.invalid/jobradar_test_pools" }) }));

afterEach(async () => { await closeMcpPools(); vi.clearAllMocks(); });

describe("dedicated MCP pools", () => {
  it("opens lazily, keeps singleton identities and freezes pool sizes until close", async () => {
    const settings = mcpSchema.parse({ http: { pool: { read_max: 7, write_max: 4 } } });
    expect(createConnection).not.toHaveBeenCalled();
    const read = getMcpReadDb(settings);
    const write = getMcpWriteDb(settings);
    expect(read).not.toBe(write);
    const changed = mcpSchema.parse({ http: { pool: { read_max: 8, write_max: 5 } } });
    expect(getMcpReadDb(changed)).toBe(read);
    expect(getMcpWriteDb(changed)).toBe(write);
    expect(createConnection).toHaveBeenCalledTimes(2);
    expect(createConnection).toHaveBeenNthCalledWith(1, expect.any(String), { max: 7, connectTimeoutSeconds: undefined, readOnly: true, sessionSettings: QUERY_SESSION_SETTINGS });
    expect(createConnection).toHaveBeenNthCalledWith(2, expect.any(String), { max: 4, sessionSettings: QUERY_SESSION_SETTINGS });
    const connections = vi.mocked(createConnection).mock.results.map((result) => result.value);
    await closeMcpPools();
    for (const connection of connections) expect(connection.sql.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(getMcpReadDb(changed)).not.toBe(read);
  });
  it("uses a single lazy audit recorder and a dedicated connection with the configured timeouts", async () => {
    const settings = mcpSchema.parse({ audit: { connect_timeout_seconds: 4, statement_timeout_ms: 500, lock_timeout_ms: 75, write_timeout_ms: 600 } });
    expect(getMcpAuditRecorder(settings)).toBe(getMcpAuditRecorder(settings));
    expect(createConnection).not.toHaveBeenCalled();
    const connection = openMcpAuditConnection(settings.audit);
    expect(createConnection).toHaveBeenCalledWith(expect.any(String), {
      max: 1, connectTimeoutSeconds: 4, sessionSettings: { statement_timeout: 500, lock_timeout: 75, idle_in_transaction_session_timeout: 500 },
    });
    await connection.end({ timeout: 0 });
  });
});
