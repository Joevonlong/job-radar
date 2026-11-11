import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { stringify } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";
import { POST as prepareRoute } from "@/app/api/career/tailor/prepare/route";
import { POST as enqueueRoute } from "@/app/api/career/tailor/route";
import { AiProviderError, createAiRouter } from "@/lib/ai";
import { createActivityRecorder } from "@/lib/activity/recorder";
import { CONTROL_ERROR_CODES, SAFE_ERROR_CODES } from "@/lib/activity/error-codes";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { resetConfigCache } from "@/lib/config";
import { createCareerTailorHandler } from "@/lib/career/tailor/handler";
import { requestCareerTailor, readCareerTailorStatus } from "@/lib/career/tailor/request";
import { loadTailorContext } from "@/lib/career/tailor/context";
import { prepareTailor } from "@/lib/career/tailor/prepare";
import * as documents from "@/lib/career/store/documents";
import * as proposals from "@/lib/career/tailor/proposals";
import * as verify from "@/lib/career/tailor/verify";
import * as outbound from "@/lib/career/ai/outbound";
import * as jobs from "@/lib/db/repos/breakdowns";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { saveCareerProfile, loadCareerProfile } from "@/lib/career/store/profile";
import { savePreferences } from "@/lib/career/store/preferences";
import { deleteCareerData } from "@/lib/career/store/delete";
import { careerDir, careerDocumentPath, careerProfilePath } from "@/lib/career/store/paths";
import { processNextControlRequest, registerControlHandler, resetControlHandlers } from "@/lib/control";
import { careerTailorPayloadSchema } from "@/lib/control/types";
import { CAREER_SCRUBBED_KINDS, expireScrubbedRequests } from "@/lib/control/expire";
import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { runCycle } from "@/lib/cycle/run-cycle";
import { createScoreJobsHandler } from "@/lib/control/score-jobs";
import { currentPreferencesSnapshotId, type ScoringProfile } from "@/lib/scoring";
import { createNotifyStep } from "@/lib/notify/step";
import { registerCycleStep } from "@/lib/cycle/steps";
import { config as cycleConfig } from "../cycle/helpers";
import { answer, exampleMe, examplePreferences } from "../scoring/helpers";
import { notifyConfig } from "../notify/helpers";
import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { closeDb, getDb, schema } from "@/lib/db";
import { createConnection } from "@/lib/db/client";
import { runMigrations } from "@/lib/db/migrate";
import { claimNextControlRequest, failOpenControlRequests, findLatestCareerTailorRequest, insertControlRequest, requeueInterruptedControlRequests } from "@/lib/db/repos/control-requests";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import * as applications from "@/lib/db/repos/applications";
import { tempCareer, profile, text } from "../career/fixtures";
import { tailorSettings } from "../career/tailor-fixtures";
import { pinnedAi, scriptedProvider, type Step } from "../ai/helpers";
import { integrationActivitySettings } from "./activity-helpers";

const url = inject("testDatabaseUrl");
const db = () => getDb();
let temp: ReturnType<typeof tempCareer>;
let records: LogRecord[];
const logger = () => createLogger({ sink: (record) => records.push(record) });
const reply = (items: unknown[] = []): Step => ({ text: JSON.stringify({ items }) });
const jsonRequest = (body: unknown) => new Request("http://127.0.0.1/api/career/tailor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const poll = () => processNextControlRequest({ db: db(), signal: new AbortController().signal, logger: logger(), kinds: () => ["career_tailor"] });
const backfill = { lockTimeoutMs: 3000, statementTimeoutMs: 60000 };
function handlerWith(steps: Step[] = [reply()], settings = tailorSettings()) {
  const { provider, transport } = scriptedProvider("codex-cli", steps);
  registerControlHandler("career_tailor", createCareerTailorHandler({ createRouter: () => createAiRouter({ config: pinnedAi(), providers: [provider], usage: null, logger: logger() }), loadSettings: () => settings }));
  return transport;
}
async function setup(mode: "tailor" | "shrink" = "tailor", source = profile("Built a service and reduced latency 40%")) {
  const saved = await saveCareerProfile(source, { baseHash: null });
  if (!saved.ok) throw new Error("fixture save failed");
  const company = await getOrCreateCompany(db(), { name: "Example Tailor", nameNorm: "example-tailor" });
  const job = await insertJob(db(), { companyId: company.id, title: "Platform Engineer", titleNorm: "platform engineer", description: "Build reliable services using kubernetes." });
  const prepared = await prepareTailor(db(), { jobId: job.id, mode: "tailor", new: true, requirements: ["Keep it concise"] });
  if (!("hash" in prepared)) throw new Error("fixture prepare failed");
  const payload = careerTailorPayloadSchema.parse({ mode, doc_id: prepared.doc_id, jobId: job.id, with_letter: false, over_pages: mode === "shrink" ? 1 : null, outbound_hash: prepared.hash });
  return { job, prepared, payload };
}
async function queue(payload: unknown) {
  const result = await requestCareerTailor(db(), payload);
  if (result.state !== "queued") throw new Error("fixture queue failed");
  return result.requestId;
}
async function row(id: number) {
  const [result] = await db().select().from(schema.controlRequests).where(eq(schema.controlRequests.id, id));
  return result!;
}
async function scrubbed(id: number, code?: string) {
  const result = await row(id);
  expect(result.payload).toMatchObject({ scrubbed: true });
  expect(Object.keys(result.payload as object).sort()).toEqual(["doc_id", "jobId", "mode", "outbound_hash", "over_pages", "scrubbed", "with_letter"].sort());
  if (code) expect(result.result).toMatchObject({ error: code });
  return result;
}
beforeAll(async () => { process.env.DATABASE_URL = url; await runMigrations({ currentScoresBackfill: backfill }); });
beforeEach(async () => {
  temp = tempCareer({ tailor: tailorSettings().tailor }); records = [];
  resetControlHandlers();
  await db().delete(schema.controlRequests);
  await db().delete(schema.activityEvents);
  await db().delete(schema.activitySpans);
});
afterEach(() => { vi.restoreAllMocks(); resetCycleSteps(); temp.cleanup(); });
afterAll(closeDb);

it("upgrades the preceding enum migration preserving existing rows", async () => {
  const address = new URL(url);
  const name = `${address.pathname.slice(1)}_tailor_upgrade`;
  if (!/^jobradar_test_[a-z0-9_]+$/.test(name)) throw new Error("expected disposable database");
  address.pathname = "/postgres";
  const admin = postgres(address.toString(), { max: 1, onnotice: () => {} });
  address.pathname = `/${name}`;
  const connection = createConnection(address.toString(), { max: 1 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tailor-upgrade-"));
  try {
    await admin.unsafe(`create database "${name}"`);
    fs.cpSync(path.resolve("drizzle"), directory, { recursive: true });
    const file = path.join(directory, "meta/_journal.json");
    const journal = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: { tag: string }[] };
    const tailor = journal.entries.findIndex((entry) => entry.tag === "0058_career_tailor_kind");
    expect(tailor).toBeGreaterThan(0);
    journal.entries.splice(tailor); fs.writeFileSync(file, JSON.stringify(journal));
    await runMigrations({ url: address.toString(), migrationsFolder: directory, currentScoresBackfill: backfill });
    expect(await findLatestCareerTailorRequest(connection.db, "doc_aaaaaaaaaa")).toBeNull();
    const previous = await insertControlRequest(connection.db, { kind: "career_extract", payload: { marker: "existing" } });
    await runMigrations({ url: address.toString(), currentScoresBackfill: backfill });
    expect((await connection.db.select().from(schema.controlRequests))[0]).toMatchObject({ id: previous.id, payload: { marker: "existing" } });
    expect((await insertControlRequest(connection.db, { kind: "career_tailor" })).kind).toBe("career_tailor");
    expect(CAREER_SCRUBBED_KINDS).toContain("career_tailor");
    expect(CONTROL_ERROR_CODES).toEqual(expect.arrayContaining(["outbound_changed", "doc_gone", "job_gone", "no_jd", "proposal_write_failed"]));
  } finally {
    await connection.sql.end(); await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.end();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["tailor", "shrink"] as const)("scrubs sentinels through the real %s path and leaves matching untouched", async (mode) => {
  const sentinels = ["Private Person", "Private Road 37\nHiddenPostalSentinel", "private@example.test", "0151 98765432", "Private permission", "Private availability", "https://private.example.test", "Private link label", "private_portrait.jpg"];
  const combined = sentinels.join(" ");
  await saveContact({ ...emptyContact(), name: sentinels[0], address: sentinels[1], email: sentinels[2], phone: sentinels[3], work_auth: sentinels[4], availability: sentinels[5], location: "Publiccity", links: [{ label: sentinels[7]!, url: sentinels[6]! }], photo: sentinels[8] }, { baseHash: null });
  const source = profile(`Built a service ${combined}`);
  source.summary = text(combined);
  source.experience[0]!.stack = [combined]; source.experience[0]!.url = "https://entry.example.invalid";
  source.experience[0]!.bullets[0]!.wordings.push({ ...source.experience[0]!.bullets[0]!.wordings[0]!, text: `Alternative ${combined}` });
  source.custom_sections = [{ id: "", title: text(combined), layout: "tags", side: "main", items: [{ id: "", kind: "tag", text: text(combined) }] }];
  const { payload } = await setup(mode, source);
  const loaded = await documents.loadDocument(payload.doc_id);
  loaded.document.requirements = [combined]; loaded.document.experience[0]!.bullets[0]!.text += ` Publiccity ${combined}`;
  await documents.saveDocument(payload.doc_id, loaded.document, { baseHash: loaded.baseHash });
  await savePreferences({ schema_version: 1, layout: tailorSettings().document.defaults, emphasis: combined, tone: combined }, { baseHash: null });
  const confirmed = await loadTailorContext(db(), payload, tailorSettings()); payload.outbound_hash = confirmed.outbound.hash;
  const beforeDocument = fs.readFileSync(careerDocumentPath(payload.doc_id), "utf8");
  const beforeProfile = fs.readFileSync(careerProfilePath(), "utf8");
  const snapshots = await db().select().from(schema.profileSnapshots);
  const scores = await db().select().from(schema.jobCurrentScores);
  const matchingFiles = ["me.yaml", "stories.yaml"].map((name) => {
    const file = path.join(temp.profileDir, name); return { file, contents: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
  });
  const target = confirmed.document.experience[0]!.bullets[0]!.id;
  const safeText = "Built a service";
  const transport = mode === "shrink"
    ? handlerWith([reply([{ action: "shorten", target: { text: target }, text: safeText, rationale: "Shorter wording" }, { action: "shorten", target: { text: target }, text: combined }])])
    : handlerWith([reply(), reply([{ action: "rewrite", target: { text: target }, text: safeText, support: [{ quote: safeText }], rationale: "Shorter wording" }, { action: "shorten", target: { text: target }, text: combined }])]);
  const response = await enqueueRoute(jsonRequest(payload)); expect(response.status).toBe(200);
  const queued = await response.json() as { requestId: number };
  const activity = createActivityRecorder({ db: db(), process: "ai-worker", autoFlush: false, loadSettings: integrationActivitySettings });
  try {
    await processNextControlRequest({ db: db(), signal: new AbortController().signal, logger: logger(), activity, kinds: () => ["career_tailor"] });
    await activity.flush();
    const surfaces = JSON.stringify([transport.calls, await scrubbed(queued.requestId), await proposals.readProposals(payload.doc_id), records, await db().select().from(schema.activityEvents), await db().select().from(schema.activitySpans)]);
    expect((await proposals.readProposals(payload.doc_id))?.items).toHaveLength(1);
    expect(surfaces).not.toContain("HiddenPostalSentinel");
    for (const sentinel of sentinels) expect(surfaces).not.toContain(sentinel);
    expect(JSON.stringify(transport.calls)).not.toContain("entry.example.invalid");
    expect(JSON.stringify(transport.calls)).toContain("Publiccity");
    expect(fs.readFileSync(careerDocumentPath(payload.doc_id), "utf8")).toBe(beforeDocument);
    expect(fs.readFileSync(careerProfilePath(), "utf8")).toBe(beforeProfile);
    expect(await db().select().from(schema.profileSnapshots)).toEqual(snapshots);
    expect(await db().select().from(schema.jobCurrentScores)).toEqual(scores);
    for (const { file, contents } of matchingFiles) expect(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null).toBe(contents);
    expect(await readCareerTailorStatus(db(), payload.doc_id)).not.toHaveProperty("payload");
  } finally { await activity.close(); }
});

it("merges identical requests and refuses different content while busy", async () => {
  const { payload } = await setup(); const id = await queue(payload);
  expect(await requestCareerTailor(db(), payload)).toMatchObject({ state: "queued", requestId: id, existing: true });
  expect(await requestCareerTailor(db(), { ...payload, caller: "stdio" })).toMatchObject({ state: "queued", requestId: id, existing: true });
  expect(await requestCareerTailor(db(), { ...payload, caller: 7 })).toMatchObject({ state: "queued", requestId: id, existing: true });
  expect(await requestCareerTailor(db(), { ...payload, with_letter: true })).toMatchObject({ error: "busy" });
});

it.each(["requirements", "profile", "preference", "jd", "contact"])("rejects changed outbound %s before calling a provider", async (part) => {
  const { payload, job } = await setup(); const transport = handlerWith(); const id = await queue(payload);
  if (part === "requirements") {
    const loaded = await documents.loadDocument(payload.doc_id);
    await documents.saveDocument(payload.doc_id, { ...loaded.document, requirements: ["Changed after confirmation"] }, { baseHash: loaded.baseHash });
  } else if (part === "profile") {
    const loaded = await loadCareerProfile(); loaded.profile.experience[0]!.stack.push("Kafka");
    await saveCareerProfile(loaded.profile, { baseHash: loaded.baseHash });
  } else if (part === "preference") {
    await savePreferences({ schema_version: 1, layout: tailorSettings().document.defaults, emphasis: "A different emphasis", tone: null }, { baseHash: null });
  } else if (part === "jd") await db().update(schema.jobs).set({ description: "Changed JD" }).where(eq(schema.jobs.id, job.id));
  else await saveContact({ ...emptyContact(), name: "Built a service" }, { baseHash: null });
  await poll(); await scrubbed(id, "outbound_changed"); expect(transport.calls).toHaveLength(0);
});

it("moves the application to preparing only when a tailoring run is newly queued", async () => {
  const { payload, job } = await setup();
  await prepareTailor(db(), { jobId: job.id, mode: "tailor", new: false, requirements: ["Keep it concise"] });
  expect(await applications.getApplicationByJobId(db(), job.id)).toBeNull();
  await queue(payload);
  const application = await applications.getApplicationByJobId(db(), job.id);
  expect(application?.status).toBe("preparing");
  await requestCareerTailor(db(), payload);
  const events = await applications.listApplicationEvents(db(), application!.id);
  expect(events.map((event) => [event.toStatus, event.note])).toEqual([["preparing", "career"]]);
});

it("never moves an applied job back", async () => {
  const { payload, job } = await setup();
  await applications.setApplicationStatus(db(), job.id, "applied");
  await queue(payload);
  expect((await applications.getApplicationByJobId(db(), job.id))?.status).toBe("applied");
});

it("never advances the status for shrink", async () => {
  const { payload, job } = await setup("shrink");
  await queue(payload);
  expect(await applications.getApplicationByJobId(db(), job.id)).toBeNull();
});

it("a failing status write does not fail the queued request", async () => {
  const { payload, job } = await setup();
  vi.spyOn(applications, "setApplicationStatus").mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "XX000" }));
  expect(await requestCareerTailor(db(), payload)).toMatchObject({ state: "queued", existing: false });
  expect(await applications.getApplicationByJobId(db(), job.id)).toBeNull();
});

it("rechecks the hash at enqueue and permits layout-only changes", async () => {
  const { payload } = await setup(); const transport = handlerWith();
  const loaded = await documents.loadDocument(payload.doc_id); loaded.document.layout.pages++;
  await documents.saveDocument(payload.doc_id, loaded.document, { baseHash: loaded.baseHash });
  const id = await queue(payload); await poll(); await scrubbed(id); expect(transport.calls).toHaveLength(2);
  const current = await documents.loadDocument(payload.doc_id); current.document.requirements.push("New instruction");
  await documents.saveDocument(payload.doc_id, current.document, { baseHash: current.baseHash });
  expect(await requestCareerTailor(db(), payload)).toMatchObject({ error: "review_again" });
});

it("each step sends original confirmed blocks and never model prose", async () => {
  const { payload } = await setup(); payload.with_letter = true;
  const loaded = await documents.loadDocument(payload.doc_id); const target = loaded.document.experience[0]!.id;
  const transport = handlerWith([reply([{ action: "include", target: { entry: target }, rationale: "MODEL_ONLY_SENTINEL" }]), reply(), reply()]);
  const id = await queue(payload); await poll(); await scrubbed(id);
  expect(transport.calls).toHaveLength(3);
  const confirmed = (await loadTailorContext(db(), payload, tailorSettings())).outbound;
  for (const call of transport.calls) {
    expect(call.user).not.toContain("MODEL_ONLY_SENTINEL");
    const blocks = [...call.user.matchAll(/<career_block id="([^"]+)">\n([\s\S]*?)\n<\/career_block>/g)];
    for (const block of blocks) expect(confirmed.blocks).toContainEqual({ id: block[1], text: block[2] });
  }
});

it.each(["document", "parse", "scrub", "jd", "provider", "verify", "publish"])("contains private exceptions at %s", async (stage) => {
  const { payload } = await setup();
  const loaded = await documents.loadDocument(payload.doc_id);
  const item = { action: "rewrite", target: { text: loaded.document.experience[0]!.bullets[0]!.id }, text: "Built a service", support: [{ quote: "Built a service" }] };
  handlerWith([reply(), reply([item])]); const id = await queue(payload);
  const failure = new Error("EXCEPTION_PRIVATE_SENTINEL");
  if (stage === "document") vi.spyOn(documents, "loadDocument").mockRejectedValue(failure);
  if (stage === "parse") fs.writeFileSync(careerDocumentPath(payload.doc_id), "EXCEPTION_PRIVATE_SENTINEL: [");
  if (stage === "scrub") vi.spyOn(outbound, "toOutbound").mockImplementation(() => { throw failure; });
  if (stage === "jd") vi.spyOn(jobs, "getJobForBreakdown").mockRejectedValue(failure);
  if (stage === "provider") handlerWith([failure]);
  if (stage === "verify") vi.spyOn(verify, "verifyProposal").mockImplementation(() => { throw failure; });
  if (stage === "publish") vi.spyOn(proposals, "writeProposals").mockRejectedValue(failure);
  await poll(); const request = await scrubbed(id);
  expect(SAFE_ERROR_CODES).toContain((request.result as { error: string }).error);
  expect(JSON.stringify([request.result, records])).not.toContain("EXCEPTION_PRIVATE_SENTINEL");
});

it.each(["disabled", "invalid_output", "output_truncated", "aborted", "timeout", "restart", "expired"])("scrubs the empty key list on %s", async (end) => {
  const { payload } = await setup(); const id = await queue(payload);
  if (end === "disabled") { fs.writeFileSync(path.join(temp.configDir, "career.yaml"), stringify({ enabled: false })); resetConfigCache(); handlerWith(); await poll(); }
  if (end === "invalid_output") { handlerWith([{ text: "bad json" }]); await poll(); }
  if (end === "output_truncated") { handlerWith([{ text: "bad json", tokensOut: 100000 }]); await poll(); }
  if (end === "aborted") {
    const transport = handlerWith(); const original = transport.call.bind(transport); const controller = new AbortController();
    vi.spyOn(transport, "call").mockImplementation(async (request) => { controller.abort(); return original(request); });
    await processNextControlRequest({ db: db(), signal: controller.signal, logger: logger(), kinds: () => ["career_tailor"] });
  }
  if (end === "timeout") { handlerWith([new AiProviderError("codex-cli", "timeout", "PRIVATE")]); await poll(); }
  if (end === "restart") { await claimNextControlRequest(db(), ["career_tailor"]); expect(await requeueInterruptedControlRequests(db(), { kinds: ["career_tailor"], reason: "restart", maxRequeues: 3 })).toEqual({ requeued: 0, failed: 1 }); }
  if (end === "expired") { await db().execute(sql`update control_requests set requested_at = now() - interval '2 hours' where id = ${id}`); await expireScrubbedRequests(db(), { careerSettings: { timeout_seconds: 10, expiry_grace_seconds: 1, queue_timeout_seconds: 10 } }); }
  await scrubbed(id, end);
});

it.each(["all", "document"])("does not resurrect files deleted during generation: %s", async (what) => {
  const { payload } = await setup(); const id = await queue(payload); const transport = handlerWith();
  const original = transport.call.bind(transport); let once = false;
  vi.spyOn(transport, "call").mockImplementation(async (request) => {
    if (!once) {
      once = true;
      if (what === "all") await deleteCareerData(() => failOpenControlRequests(db(), CAREER_SCRUBBED_KINDS, "deleted").then(() => {}));
      else await documents.deleteDocument(payload.doc_id);
    }
    return original(request);
  });
  await poll(); await scrubbed(id, what === "all" ? "deleted" : "doc_gone");
  expect(fs.existsSync(proposals.proposalsPath(payload.doc_id))).toBe(false);
  if (what === "all") expect(fs.existsSync(careerDir())).toBe(false);
});

it("prepare reports existing documents and never enqueues, including when disabled", async () => {
  const { job } = await setup();
  expect(await prepareTailor(db(), { jobId: job.id, mode: "tailor" })).toMatchObject({ existing: true });
  expect(await db().select().from(schema.controlRequests)).toEqual([]);
  fs.writeFileSync(path.join(temp.configDir, "career.yaml"), stringify({ enabled: false })); resetConfigCache();
  const response = await prepareRoute(jsonRequest({ jobId: job.id, mode: "tailor" }));
  expect(response.status).toBe(409); expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("general documents can shrink and edits during generation do not become stale", async () => {
  const { payload } = await setup("shrink");
  const loaded = await documents.loadDocument(payload.doc_id);
  const general = { ...loaded.document, id: "", kind: "general", job: null };
  const created = await documents.createDocument(general);
  payload.doc_id = created.document.id; payload.jobId = null;
  payload.outbound_hash = (await loadTailorContext(db(), payload, tailorSettings())).outbound.hash;
  const transport = handlerWith(); const original = transport.call.bind(transport);
  vi.spyOn(transport, "call").mockImplementation(async (request) => {
    const current = await documents.loadDocument(payload.doc_id);
    expect(await documents.saveDocument(payload.doc_id, { ...current.document, title: "Edited while generating" }, { baseHash: current.baseHash })).toMatchObject({ ok: true });
    return original(request);
  });
  const id = await queue(payload); await poll(); await scrubbed(id);
  expect((await proposals.readProposals(payload.doc_id))?.doc_hash).toBe(created.baseHash);
  expect((await documents.loadDocument(payload.doc_id)).baseHash).not.toBe(created.baseHash);
});

it("scoring notifications and a runner cycle never enqueue tailoring", async () => {
  const { job } = await setup();
  const me = exampleMe(); const preferences = examplePreferences();
  const scoringProfile: ScoringProfile = { me, preferences, meYaml: stringify(me), preferencesYaml: stringify(preferences) };
  const snapshot = await currentPreferencesSnapshotId(db(), scoringProfile);
  await withRebuiltCurrentScores(db(), db().insert(schema.scores).values({ jobId: job.id, profileSnapshotId: snapshot, filterResult: "passed" }));
  const config = pinnedAi(); const { provider } = scriptedProvider("codex-cli", [answer({ score: 50 })]);
  const router = createAiRouter({ config, providers: [provider], usage: null, logger: logger() });
  registerControlHandler("score_jobs", createScoreJobsHandler({ createDeps: () => ({ db: db(), router, config, logger: logger(), now: () => new Date(), loadProfile: async () => scoringProfile, loadBonusCap: () => 15 }) }));
  await insertControlRequest(db(), { kind: "score_jobs", payload: { jobIds: [job.id] } });
  await processNextControlRequest({ db: db(), logger: logger(), signal: new AbortController().signal, kinds: () => ["score_jobs"] });
  registerBuiltinCycleSteps();
  registerCycleStep("notify", createNotifyStep({ loadNotifyConfig: () => notifyConfig((raw) => { raw.telegram.enabled = false; }) }));
  await runCycle("manual", { db: db(), registry: new ChannelRegistry(), config: cycleConfig(), logger: logger(), sleep: async () => {}, fetch: async () => { throw new Error("unexpected network"); } });
  expect(await db().select().from(schema.controlRequests).where(eq(schema.controlRequests.kind, "career_tailor"))).toEqual([]);
});
