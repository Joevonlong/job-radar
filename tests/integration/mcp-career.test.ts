import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

vi.mock("@/lib/dashboard/context", () => ({ getDisplayTimeZone: () => "UTC" }));
vi.mock("@/lib/career/store/images", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/career/store/images")>(), loadImages: async () => ({}),
}));

import { POST as preview } from "@/app/api/career/documents/preview/route";
import { PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";
import { reloadConfig } from "@/lib/config";
import { sha256 } from "@/lib/config/atomic";
import { newId } from "@/lib/career/schema/ids";
import { documentSchema, type CareerDocument } from "@/lib/career/schema/document";
import { visitProfile } from "@/lib/career/schema/profile";
import { loadDocument } from "@/lib/career/store/documents";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { closeDb, getDb, schema } from "@/lib/db";
import { createReadOnlyDb, type ReadOnlyDb } from "@/lib/db/read-only-client";
import { listJobsToTrapScan, saveTrapScan, type TrapInsert } from "@/lib/db/repos/traps";
import { getCareerProfileOutput, listCareerDocumentsOutput, getCareerDocumentOutput, checkCareerDocumentOutput } from "@/lib/mcp/dto";
import { rulesFingerprint } from "@/lib/traps/fingerprint";
import { descriptionHash } from "@/lib/translation/hash";
import { document, richProfile } from "../career/document-fixtures";
import { contactSentinels, sentinels, sentinelText } from "../career/redaction-fixtures";
import { tempCareer } from "../career/fixtures";
import { personalClient, fileHashes, databaseHashes } from "./mcp-personal-helpers";

const url = inject("testDatabaseUrl");
const careerTools = ["get_career_profile", "list_career_documents", "get_career_document", "check_career_document"];
let temp: ReturnType<typeof tempCareer>;
let readonly: ReadOnlyDb;
let connection: Awaited<ReturnType<typeof personalClient>> | undefined;
let doc: CareerDocument;
let jobId: number;
let profileVersion: string;
let documentVersion: string;
const quote = "Fictional hidden evidence";

beforeAll(() => { process.env.DATABASE_URL = url; readonly = createReadOnlyDb({ url }); });
afterAll(async () => { await readonly.close(); await closeDb(); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await connection?.close(); connection = undefined; temp.cleanup(); });
beforeEach(async () => {
  temp = tempCareer();
  const career = path.join(temp.profileDir, "career");
  fs.mkdirSync(path.join(career, "documents"), { recursive: true });
  fs.writeFileSync(path.join(career, "contact.yaml"), stringify(contactSentinels));
  fs.writeFileSync(path.join(career, "photo.png"), Buffer.from("fictional image bytes"));
  fs.writeFileSync(path.join(temp.profileDir, "me.yaml"), "private-me-sentinel");
  fs.writeFileSync(path.join(temp.profileDir, "preferences.yaml"), "private-preferences-sentinel");
  const profile = richProfile();
  visitProfile(profile, (item) => {
    if ("created_at" in item) Object.assign(item, { text: sentinelText, label: sentinelText, from_document: sentinelText, from_story: sentinelText });
  });
  profile.adopted_entries = ["123:summary"];
  const profileText = stringify(profile);
  fs.writeFileSync(path.join(career, "profile.yaml"), profileText);
  const [company] = await getDb().insert(schema.companies).values({ name: "Fictional Observatory", nameNorm: "fictional observatory" }).returning();
  const [job] = await getDb().insert(schema.jobs).values({ companyId: company!.id, title: "Engineer", titleNorm: "engineer", description: quote }).returning();
  jobId = job!.id;
  doc = document();
  doc.kind = "tailored";
  doc.job = { id: jobId, company: sentinelText, title: sentinelText, jd_hash: descriptionHash(quote) };
  doc.profile_hash = sha256(profileText);
  doc.title = sentinelText;
  doc.headline!.text = sentinelText.replace("Fictional", "Fictional\u200b");
  doc.summary!.text = `${sentinelText} ${temp.root}/private.txt`;
  doc.experience[0]!.bullets[0]!.text = sentinelText;
  doc.experience[0]!.url = contactSentinels.links[0]!.url;
  doc.layout.filename = sentinelText;
  doc.letter = {
    recipient: [sentinelText], place: sentinelText, date: "2026-01-01", subject: sentinelText, salutation: sentinelText,
    closing: sentinelText, body: [{ id: newId("dtx"), source: null, origin: "user", text: sentinelText }],
  };
  doc = documentSchema.parse(doc);
  const docText = stringify(doc);
  fs.writeFileSync(path.join(career, `documents/${doc.id}.yaml`), docText);
  fs.writeFileSync(path.join(career, "documents/doc_zzzzzzzzzz.yaml"), "invalid: [");
  profileVersion = `2026-01-01T00-00-00.000Z-${sha256(profileText).slice(0, 8)}.yaml`;
  documentVersion = `2026-01-01T00-00-00.000Z-${sha256(docText).slice(0, 8)}.yaml`;
  for (const [directory, name, text] of [
    ["profile", profileVersion, profileText], [`documents/${doc.id}`, documentVersion, docText],
  ]) {
    fs.mkdirSync(path.join(career, "history", directory!), { recursive: true });
    fs.writeFileSync(path.join(career, "history", directory!, name!), text!);
  }
  fs.writeFileSync(path.join(career, `documents/${doc.id}.proposals.yaml`), stringify({
    schema_version: 1, doc_id: doc.id, doc_hash: sha256(docText), request_id: 1,
    items: [{
      id: "prp_aaaaaaaaaa", action: "rewrite", target: { text: doc.headline!.id }, text: sentinelText,
      rationale: sentinelText, support: [{ quote }, { quote: sentinelText }, { entry: doc.experience[0]!.id }],
      claims: [{ id: "clm_aaaaaaaaaa", target: { text: doc.headline!.id }, kind: "fact", text: sentinelText, status: "pending", by: "ai" }],
    }],
  }));
  await recordScan();
});

async function recordScan(findings: TrapInsert[] = []) {
  const rulesHash = rulesFingerprint(reloadConfig("traps"));
  const [candidate] = await listJobsToTrapScan(getDb(), { rulesHash, limit: 1, jobIds: [jobId], force: true });
  await saveTrapScan(getDb(), { ...candidate!, rulesHash, findings, needsAi: false, spansHash: null });
}
async function connect(permissions: Permission[] = ["career:read"], transport: "stdio" | "http" = "stdio") {
  await connection?.close();
  connection = await personalClient(readonly.db, permissions, { transport });
  return connection;
}
async function call(name: string, args = {}) {
  const response = await connection!.client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  for (const value of [...sentinels, temp.root, "private-me-sentinel", "private-preferences-sentinel", "fictional image bytes"]) {
    expect(JSON.stringify(response)).not.toContain(value);
  }
  return response.structuredContent;
}
const argsFor = (name: string) => name === "check_career_document" ? { id: doc.id, doc: "resume" }
  : name === "get_career_document" ? { id: doc.id } : {};

it.each(["stdio", "http"] as const)("reads every career surface with only its permission and all permissions over %s without writes", async (transport) => {
  for (const permissions of [["career:read"], [...PERMISSIONS]] as Permission[][]) {
    const { audit } = await connect(permissions, transport);
    const files = fileHashes(temp.root);
    const database = await databaseHashes(getDb());
    const profile = getCareerProfileOutput.parse(await call("get_career_profile"));
    expect(profile).toMatchObject({ baseHash: (await loadCareerProfile()).baseHash, hasPhoto: true, hasSignature: false, version: null });
    expect(profile.profile).not.toHaveProperty("adopted_entries");
    expect(profile.versions).toEqual([{ id: profileVersion, createdAt: "2026-01-01T00:00:00.000Z", hash: profileVersion.slice(25, 33) }]);
    expect(getCareerProfileOutput.parse(await call("get_career_profile", { version: profileVersion })).baseHash).toBeNull();
    const listed = listCareerDocumentsOutput.parse(await call("list_career_documents"));
    expect(listed).toMatchObject({ total: 2, documents: [{ id: doc.id, status: "ok", jobId }, { id: "doc_zzzzzzzzzz", status: "invalid", title: null }] });
    const current = getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id }));
    expect(current.baseHash).toBe((await loadDocument(doc.id)).baseHash);
    expect(current.source).toEqual({ jdChanged: false, profileChanged: false });
    expect(current.proposals).toMatchObject({ status: "ok", stale: false, items: [{ rationale: expect.stringContaining("[name]"), support: expect.arrayContaining([{ quote }]) }] });
    expect(current.notices).toContain(connection!.ctx.text("notice.thirdParty"));
    const historical = getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id, version: documentVersion }));
    expect(historical.baseHash).toBeNull();
    expect(historical.document).toEqual(current.document);
    for (const kind of ["resume", "letter"]) {
      for (const version of [undefined, documentVersion]) {
        const checked = checkCareerDocumentOutput.parse(await call("check_career_document", { id: doc.id, doc: kind, ...(version ? { version } : {}) }));
        expect(checked).toMatchObject({ renderable: true, pageBudget: { pages: expect.any(Number) }, text: expect.stringContaining("[name]") });
        expect(checked).not.toHaveProperty("html");
      }
    }
    expect(audit.every((entry) => entry.target === null && entry.outcome === "ok")).toBe(true);
    expect(audit.map((entry) => entry.returned_count)).toEqual([1, 1, 2, 1, 1, 1, 1, 1, 1]);
    expect(fileHashes(temp.root)).toEqual(files);
    expect(await databaseHashes(getDb())).toEqual(database);
  }
});

it.each([[], ["profile:read"], ["writer:read"], ["replies:read"]] as Permission[][])("hides and refuses career tools for %j", async (...permissions) => {
  await connect(permissions as Permission[]);
  const names = (await connection!.client.listTools()).tools.map((tool) => tool.name);
  for (const name of careerTools) {
    expect(names).not.toContain(name);
    expect((await connection!.client.callTool({ name, arguments: argsFor(name) })).isError).toBe(true);
  }
});

it.each(["resume", "letter"] as const)("matches the web %s finding codes using real contact without revealing its values", async (kind) => {
  await connect();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(connection!.ctx.now());
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify({ ...contactSentinels, phone: "0555 87654321" }));
  const checked = checkCareerDocumentOutput.parse(await call("check_career_document", { id: doc.id, doc: kind }));
  const response = await preview(new Request("http://localhost/api/career/documents/preview", {
    method: "POST", body: JSON.stringify({ document: doc, doc: kind }),
  }));
  expect(response.status).toBe(200);
  const web = await response.json();
  const codes = (items: { code: string }[]) => items.map(({ code }) => code).sort();
  expect(codes(checked.findings)).toEqual(codes(web.findings));
  expect(codes(checked.exportHints!.findings)).toEqual(codes(web.exportHints.findings));
  expect(codes(checked.exportHints!.findings)).toContain("career.lint.phone_country");
  expect(codes(checked.exportHints!.findings)).not.toContain("career.lint.work_auth_missing");
  const findings = [...checked.findings, ...checked.exportHints!.findings];
  expect(JSON.stringify(findings)).not.toContain("0555 87654321");
  for (const finding of findings) expect(Object.values(finding.params).every((value) => typeof value === "number")).toBe(true);
});

it.each(["resume", "letter"] as const)("keeps protected name characters out of all %s font diagnostics", async (kind) => {
  const name = "张三丰";
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify({ ...contactSentinels, name }));
  doc.headline!.text = `${name} 中文`;
  doc.letter!.body[0]!.text = `${name} 中文`;
  fs.writeFileSync(path.join(temp.profileDir, `career/documents/${doc.id}.yaml`), stringify(doc));
  await connect();
  const read = vi.spyOn(fs, "readFileSync");
  const response = await connection!.client.callTool({ name: "check_career_document", arguments: { id: doc.id, doc: kind } });
  expect(response.isError).not.toBe(true);
  const checked = checkCareerDocumentOutput.parse(response.structuredContent);
  expect(checked.text).toContain("[name]");
  expect(checked.uncovered).toEqual(["中", "文"]);
  expect(checked.exportHints!.uncovered).toEqual(["中", "文"]);
  for (const character of name) expect(JSON.stringify(response)).not.toContain(character);
  expect(read.mock.calls.filter(([file]) => String(file).endsWith("contact.yaml"))).toHaveLength(1);
});

it.each([...sentinels, "/Users/Fictional/private.txt"])("scrubs %s from saved job hashes and accent values", async (sentinel) => {
  await connect();
  doc.job!.jd_hash = sentinel;
  if (documentSchema.safeParse({ ...doc, layout: { ...doc.layout, accent: sentinel } }).success) doc.layout.accent = sentinel;
  fs.writeFileSync(path.join(temp.profileDir, `career/documents/${doc.id}.yaml`), stringify(doc));
  const response = await call("get_career_document", { id: doc.id });
  expect(JSON.stringify(response)).not.toContain(sentinel);
});

it("career permission alone cannot read matching profile or preferences, and does not open their files", async () => {
  await connect();
  const read = vi.spyOn(fs, "readFileSync");
  await call("get_career_profile");
  await call("get_career_document", { id: doc.id });
  expect(read.mock.calls.some(([file]) => /\/(?:me|preferences)\.yaml$/.test(String(file)))).toBe(false);
  expect(read.mock.calls.filter(([file]) => String(file).endsWith("contact.yaml"))).toHaveLength(2);
  expect(read.mock.calls.some(([file]) => /\/(?:photo|signature)\.(?:png|jpg)$/.test(String(file)))).toBe(false);
  expect((await connection!.client.callTool({ name: "get_profile", arguments: {} })).isError).toBe(true);
});

it.each(["off", "broken", "missing", "absent reader"])("closes the feature gate when %s, even for an existing connection", async (state) => {
  await connect();
  expect((await connection!.client.listTools()).tools.map((tool) => tool.name)).toEqual(careerTools);
  const config = path.join(temp.configDir, "career.yaml");
  if (state === "off") fs.writeFileSync(config, "config_version: 2\nenabled: false\n");
  if (state === "broken") fs.writeFileSync(config, "enabled: [");
  if (state === "missing") { fs.rmSync(config); fs.rmSync(path.join(temp.defaultsDir, "career.yaml")); }
  if (state === "absent reader") connection!.ctx.features = undefined;
  expect((await connection!.client.listTools()).tools).toEqual([]);
  for (const name of careerTools) {
    const response = await connection!.client.callTool({ name, arguments: argsFor(name) });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("not enabled");
    expect(connection!.audit.at(-1)).toMatchObject({ error_category: "disabled" });
  }
});

it.each(["invalid", "unreadable"])("fails all career reads closed with %s contact, without paths or content", async (state) => {
  await connect();
  const file = path.join(temp.profileDir, "career/contact.yaml");
  if (state === "invalid") fs.writeFileSync(file, "name: [private-contact-marker");
  else { fs.rmSync(file); fs.mkdirSync(file); }
  for (const name of careerTools) {
    const response = await connection!.client.callTool({ name, arguments: argsFor(name) });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).not.toMatch(/private-contact-marker|contact.yaml/);
    expect(JSON.stringify(response)).not.toContain(temp.root);
    expect(connection!.audit.at(-1)).toMatchObject({ error_category: "unavailable" });
  }
});

it("reports missing profiles, documents and versions without leaking storage errors", async () => {
  await connect();
  fs.rmSync(path.join(temp.profileDir, "career/profile.yaml"));
  expect(getCareerProfileOutput.parse(await call("get_career_profile"))).toMatchObject({ baseHash: null, updatedAt: null, profile: { experience: [] } });
  for (const args of [{ id: "doc_bbbbbbbbbb" }, { id: doc.id, version: "2020-01-01T00-00-00.000Z-aaaaaaaa.yaml" }]) {
    expect((await connection!.client.callTool({ name: "get_career_document", arguments: args })).isError).toBe(true);
    expect(connection!.audit.at(-1)).toMatchObject({ error_category: "not_found" });
  }
  expect((await connection!.client.callTool({ name: "check_career_document", arguments: { id: doc.id, doc: "resume", document: doc } })).isError).toBe(true);
});

it("reports source changes, stale proposals, unreadable proposals and non-renderable documents", async () => {
  await connect();
  await getDb().update(schema.jobs).set({ description: "Different job description" }).where(eq(schema.jobs.id, jobId));
  fs.appendFileSync(path.join(temp.profileDir, "career/profile.yaml"), "\n");
  doc.experience[0]!.start = null;
  fs.writeFileSync(path.join(temp.profileDir, `career/documents/${doc.id}.yaml`), stringify(doc));
  const changed = getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id }));
  expect(changed.source).toEqual({ jdChanged: true, profileChanged: true });
  expect(changed.proposals).toMatchObject({ status: "ok", stale: true, items: [{ support: expect.arrayContaining([{ quote: null }]) }] });
  const checked = checkCareerDocumentOutput.parse(await call("check_career_document", { id: doc.id, doc: "resume" }));
  expect(checked).toMatchObject({ renderable: false, text: null, pageBudget: null, issues: [{ path: expect.any(String), code: expect.any(String) }] });
  const proposals = path.join(temp.profileDir, `career/documents/${doc.id}.proposals.yaml`);
  fs.writeFileSync(proposals, "invalid: [");
  expect(getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id })).proposals).toEqual({ status: "unavailable", stale: null, items: [] });
  fs.rmSync(proposals);
  expect(getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id })).proposals).toBeNull();
});

it("withholds hidden JD evidence and cleans third-party instructions in proposals", async () => {
  await recordScan([{
    technique: "hidden_text", method: "display_none", severity: "trap", quote, quoteSource: "description", quoteOffset: 0,
    location: "description", rawPostingId: null, evidence: null, detail: {}, inDescription: true,
  }]);
  await connect();
  const result = getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id }));
  expect(JSON.stringify(result.proposals)).not.toContain(quote);
  expect(result.proposals?.items[0]?.support[0]).toEqual({ quote: reloadConfig("traps").ai_input.hidden_marker });
  connection!.ctx.traps = () => { throw new Error("private-path-sentinel"); };
  expect(getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id })).proposals?.items[0]?.support[0]).toEqual({ quote: null });
});


it("returns null source status where inapplicable and sanitizes store failures", async () => {
  await connect();
  doc.job = null;
  doc.profile_hash = null;
  fs.writeFileSync(path.join(temp.profileDir, `career/documents/${doc.id}.yaml`), stringify(doc));
  expect(getCareerDocumentOutput.parse(await call("get_career_document", { id: doc.id })).source)
    .toEqual({ jdChanged: null, profileChanged: null });
  fs.writeFileSync(path.join(temp.profileDir, "career/profile.yaml"), "profile: [private-profile-marker");
  const result = await connection!.client.callTool({ name: "get_career_profile", arguments: {} });
  expect(result.isError).toBe(true);
  expect(connection!.audit.at(-1)).toMatchObject({ error_category: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("private-profile-marker");
  expect(JSON.stringify(result)).not.toContain(temp.root);
});
