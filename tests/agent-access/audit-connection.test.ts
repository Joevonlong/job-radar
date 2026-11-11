// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnection, databaseUrlFor, type Db } from "@/lib/db/client";
import { openAgentCallsConnection } from "@/lib/db/repos/agent-calls";

vi.mock("@/lib/db/client", () => ({ createConnection: vi.fn(), databaseUrlFor: vi.fn(() => "test-url") }));
afterEach(() => vi.clearAllMocks());

describe("audit connection", () => {
  it.each(["url", "pool"])("opens one bounded writable session from a %s", (source) => {
    const db = {} as Db;
    openAgentCallsConnection(source === "url" ? "test-url" : db, { connectTimeoutSeconds: 3, statementTimeoutMs: 1100, lockTimeoutMs: 50 });
    expect(createConnection).toHaveBeenCalledExactlyOnceWith("test-url", {
      max: 1, connectTimeoutSeconds: 3,
      sessionSettings: { statement_timeout: 1100, lock_timeout: 50, idle_in_transaction_session_timeout: 1100 },
    });
    if (source === "pool") expect(databaseUrlFor).toHaveBeenCalledExactlyOnceWith(db);
    else expect(databaseUrlFor).not.toHaveBeenCalled();
  });
});
