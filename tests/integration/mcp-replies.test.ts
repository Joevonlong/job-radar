import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it } from "vitest";
import { PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";
import { closeDb, getDb, schema } from "@/lib/db";
import { replyReadQuery } from "@/lib/db/queries/replies";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { listRepliesOutput } from "@/lib/mcp/dto";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { personalClient, fileHashes, databaseHashes } from "./mcp-personal-helpers";

const url = inject("testDatabaseUrl");
const privateColumns = ["subject", "quote", "sender_domain", "message_id", "thread_id", "raw_ref", "dedupe_key", "candidates", "suggestion"];
const sentinel = "private-mail-sentinel";
let readonly: ReadOnlyDb;
let temp: TempConfig;
let connection: Awaited<ReturnType<typeof personalClient>> | undefined;
let replyId: number;
let jobId: number;
let companyId: number;
beforeAll(() => { process.env.DATABASE_URL = url; readonly = createReadOnlyDb({ url }); });
afterAll(async () => { await readonly.close(); await closeDb(); });
afterEach(async () => { await connection?.close(); connection = undefined; temp.cleanup(); });
beforeEach(async () => {
  temp = makeTempConfig();
  fs.writeFileSync(path.join(temp.configDir, "replies.yaml"), "config_version: 2\nenabled: true\n");
  const [company] = await getDb().insert(schema.companies).values({ name: "Fictional\u200b Observatory", nameNorm: "fictional observatory" }).returning();
  companyId = company!.id;
  const [job] = await getDb().insert(schema.jobs).values({ companyId: company!.id, title: "Fictional\u200b Engineer", titleNorm: "fictional engineer" }).returning();
  jobId = job!.id;
  const [application] = await getDb().insert(schema.applications).values({ jobId, status: "applied" }).returning();
  const privateFields = {
    subject: sentinel, quote: sentinel, senderDomain: sentinel, messageId: sentinel, threadId: sentinel, rawRef: sentinel,
    candidates: [{ private: sentinel }], suggestion: { private: sentinel },
  };
  const [reply] = await getDb().insert(schema.emailReplies).values({
    ...privateFields, dedupeKey: sentinel, receivedAt: new Date("2026-01-02T10:00:00Z"),
    category: "other", userCategory: "interview_invite", match: "matched", state: "pending", jobId, applicationId: application!.id,
  }).returning({ id: schema.emailReplies.id });
  replyId = reply!.id;
  await getDb().insert(schema.emailReplies).values({
    ...privateFields, dedupeKey: `${sentinel}-older`, receivedAt: new Date("2026-01-01T10:00:00Z"), category: "rejection",
    match: "unmatched", state: "dismissed",
  });
});

async function connect(permissions: Permission[] = ["replies:read"], transport: "stdio" | "http" = "stdio", maxResults = 100) {
  await connection?.close();
  connection = await personalClient(readonly.db, permissions, { transport, maxResults });
}
async function call(args = {}) {
  const response = await connection!.client.callTool({ name: "list_replies", arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(JSON.stringify(response)).not.toContain(sentinel);
  expect(JSON.stringify(response)).not.toContain(temp.root);
  return listRepliesOutput.parse(response.structuredContent);
}

it.each(["stdio", "http"] as const)("reads only reply metadata with isolated and full permissions over %s without writes", async (transport) => {
  for (const permissions of [["replies:read"], [...PERMISSIONS]] as Permission[][]) {
    await connect(permissions, transport);
    const files = fileHashes(temp.root);
    const database = await databaseHashes(getDb());
    const data = await call();
    expect(data).toMatchObject({ total: 2, returned: 2, truncated: false });
    expect(data.replies).toEqual([
      { id: replyId, receivedAt: "2026-01-02T10:00:00.000Z", category: "interview_invite", match: "matched", state: "pending", jobId, company: "Fictional Observatory", title: "Fictional Engineer", applicationStatus: "applied" },
      { id: replyId + 1, receivedAt: "2026-01-01T10:00:00.000Z", category: "rejection", match: "unmatched", state: "dismissed", jobId: null, company: null, title: null, applicationStatus: null },
    ]);
    expect(data.notices).toEqual([connection!.ctx.text("notice.thirdParty")]);
    expect(connection!.audit[0]).toMatchObject({ capability: "list_replies", returned_count: 2, target: null, transport });
    expect(fileHashes(temp.root)).toEqual(files);
    expect(await databaseHashes(getDb())).toEqual(database);
  }
});

it("selects only the public columns before mapping, without bringing mail into memory", () => {
  const query = replyReadQuery(readonly.db, { limit: 1 }).toSQL().sql;
  const selection = query.slice(0, query.indexOf(" from "));
  expect(selection.match(/"[a-z_]+"\."[a-z_]+"/g)).toEqual([
    '"email_replies"."id"', '"email_replies"."received_at"', '"email_replies"."category"', '"email_replies"."user_category"',
    '"email_replies"."match"', '"email_replies"."state"', '"email_replies"."job_id"', '"companies"."name"', '"jobs"."title"', '"applications"."status"',
  ]);
  for (const column of privateColumns) expect(query).not.toContain(`"${column}"`);
  expect(query).not.toContain("*");
});

it.each(["secret@example.test", "/Users/Fictional/private.txt", "C:\\Fictional\\private.txt"])("cleans %s from company and title metadata", async (value) => {
  await getDb().update(schema.companies).set({ name: value }).where(eq(schema.companies.id, companyId));
  await getDb().update(schema.jobs).set({ title: value }).where(eq(schema.jobs.id, jobId));
  await connect();
  const result = await call();
  expect(result.replies[0]).toMatchObject({ company: connection!.ctx.text("notice.redacted"), title: connection!.ctx.text("notice.redacted") });
  expect(JSON.stringify(result)).not.toContain(value);
});

it("filters by effective category, state and received timestamp, with the configured cap", async () => {
  await connect(["replies:read"], "stdio", 1);
  expect(await call({ limit: 99 })).toMatchObject({ total: 2, returned: 1, truncated: true, replies: [{ id: replyId }] });
  expect((await call()).notices).toHaveLength(2);
  expect(await call({ category: "other" })).toMatchObject({ total: 0, returned: 0 });
  expect(await call({ category: "interview_invite", state: "pending", since: "2026-01-02T00:00:00Z" })).toMatchObject({ total: 1, returned: 1, truncated: false });
  expect(await call({ state: "dismissed" })).toMatchObject({ replies: [{ id: replyId + 1 }] });
  for (const args of [{ state: "unknown" }, { since: "yesterday" }, { limit: 0 }, { subject: sentinel }]) {
    expect((await connection!.client.callTool({ name: "list_replies", arguments: args })).isError).toBe(true);
  }
});

it.each(["off", "broken", "missing", "absent reader"])("hides replies and refuses direct calls when the feature is %s", async (state) => {
  await connect();
  expect((await connection!.client.listTools()).tools.map((tool) => tool.name)).toEqual(["list_replies"]);
  const file = path.join(temp.configDir, "replies.yaml");
  if (state === "off") fs.writeFileSync(file, "config_version: 2\nenabled: false\n");
  if (state === "broken") fs.writeFileSync(file, "enabled: [");
  if (state === "missing") { fs.rmSync(file); fs.rmSync(path.join(temp.defaultsDir, "replies.yaml")); }
  if (state === "absent reader") connection!.ctx.features = undefined;
  expect((await connection!.client.listTools()).tools).toEqual([]);
  const result = await connection!.client.callTool({ name: "list_replies", arguments: {} });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("not enabled");
  expect(connection!.audit.at(-1)).toMatchObject({ error_category: "disabled" });
});

it.each([[], ["profile:read"], ["writer:read"], ["career:read"]] as Permission[][])("does not grant replies from %j", async (...permissions) => {
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), stringify({ config_version: 2, enabled: true }));
  await connect(permissions as Permission[]);
  expect((await connection!.client.listTools()).tools.map((tool) => tool.name)).not.toContain("list_replies");
  expect((await connection!.client.callTool({ name: "list_replies", arguments: {} })).isError).toBe(true);
  expect(connection!.audit.at(-1)).toMatchObject({ outcome: "not_permitted" });
});
