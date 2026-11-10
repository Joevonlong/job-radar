import fs from "node:fs";
import { afterEach, expect, test } from "vitest";
import { markOf } from "@/lib/career/document/marks";
import { applyProposal, acceptProposal } from "@/lib/career/tailor/apply";
import { proposalInputSchema, type Proposal } from "@/lib/career/tailor/proposal-schema";
import { verifyProposal } from "@/lib/career/tailor/verify";
import { readProposals, writeProposals, proposalsPath } from "@/lib/career/tailor/proposals";
import { createDocument, loadDocument, saveDocument } from "@/lib/career/store/documents";
import { loadCareerProfile, saveCareerProfile } from "@/lib/career/store/profile";
import { careerProfilePath } from "@/lib/career/store/paths";
import { saveBack, saveBackToProfile } from "@/lib/career/document/save-back";
import { confirmTranslation, decideClaim, rerunClaims } from "@/lib/career/document/claims";
import type { Claim } from "@/lib/career/schema/document";
import { tempCareer, profile } from "./fixtures";
import { tailorFixture } from "./tailor-fixtures";
import { newId } from "@/lib/career/schema/ids";

let temp: ReturnType<typeof tempCareer> | undefined;
afterEach(() => { temp?.cleanup(); temp = undefined; });
function proposal(context: ReturnType<typeof tailorFixture>, patch: Record<string, unknown> = {}): Proposal {
  return verifyProposal(proposalInputSchema.parse({ action: "add", target: { list: `${context.doc.experience[0]!.id}.bullets` }, text: "Reduced batch time", support: [{ quote: "Reduced nightly batch time" }], ...patch }), context)!;
}

const claim = (target: string, patch: Partial<Claim> = {}): Claim => ({ id: newId("clm"), target: { text: target }, kind: "figure", text: "40%", in_jd: false, translation: false, status: "pending", by: "ai", ...patch });
test.each([
  ["source", [], "verbatim"], ["ai", [], "rewritten"], ["user", [], "user_written"],
  ["user", [{ status: "confirmed" }], "confirmed"], ["ai", [{ status: "noted", by: "user" }], "user_written"],
  ["source", [{ status: "pending" }], "unverified"], ["ai", [{ status: "rejected" }], "unverified"],
  ["user", [{ status: "confirmed" }, { status: "pending" }], "unverified"],
] as const)("marks %s with %j as %s", (origin, patches, expected) => {
  const context = tailorFixture(); context.text.origin = origin;
  expect(markOf(context.text, patches.map((patch) => claim(context.text.id, patch)))).toBe(expected);
});

test("accepting adds once and a missing target is reported", () => {
  const context = tailorFixture(); const item = proposal(context);
  const first = applyProposal(context.doc, item, context.settings);
  const second = applyProposal(first.document, item, context.settings);
  expect(second.document).toEqual(first.document);
  expect(second.document.experience[0]!.bullets).toHaveLength(2);
  expect(second.document.layout).toEqual(context.doc.layout);
  context.doc.experience = [];
  expect(applyProposal(context.doc, item, context.settings)).toEqual({ document: context.doc, state: "target_gone" });
});

test("drop preserves the entry and restores inclusion", () => {
  const context = tailorFixture();
  const item = proposal(context, { action: "drop", target: { entry: context.doc.experience[0]!.id } });
  const dropped = applyProposal(context.doc, item, context.settings).document;
  expect(dropped.experience[0]!.included).toBe(false);
  expect(applyProposal(dropped, { ...item, action: "include" }, context.settings).document.experience[0]!.included).toBe(true);
});

test("proposals live separately, survive document edits and roll back failed completion", async () => {
  temp = tempCareer(); const context = tailorFixture();
  const created = await createDocument(context.doc);
  const bundle = { schema_version: 1 as const, doc_id: context.doc.id, doc_hash: created.baseHash, request_id: 1, items: [proposal(context)] };
  expect(await writeProposals(bundle, async () => true, async () => true)).toBe(true);
  expect((await loadDocument(context.doc.id)).baseHash).toBe(created.baseHash);
  expect((fs.statSync(proposalsPath(context.doc.id)).mode & 0o777)).toBe(0o600);
  expect((await readProposals(context.doc.id))?.items).toHaveLength(1);
  const saved = await saveDocument(context.doc.id, { ...context.doc, title: "Edited" }, { baseHash: created.baseHash });
  expect(saved.ok).toBe(true);
  const current = await loadDocument(context.doc.id);
  const accepted = await acceptProposal(context.doc.id, bundle.items[0]!.id, current.baseHash);
  expect(accepted.ok).toBe(true);
  expect(await acceptProposal(context.doc.id, bundle.items[0]!.id, created.baseHash)).toMatchObject({ ok: true, state: "missing" });
  expect((await readProposals(context.doc.id))?.items).toHaveLength(0);
  expect(await writeProposals(bundle, async () => true, async () => false)).toBe(false);
  expect(await readProposals(context.doc.id)).toBeNull();
});

test("proposal schema failures never expose contents", async () => {
  temp = tempCareer(); const context = tailorFixture();
  fs.mkdirSync(proposalsPath(context.doc.id).replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(proposalsPath(context.doc.id), "private sentinel");
  await expect(readProposals(context.doc.id)).rejects.toMatchObject({ code: "proposal_invalid" });
});

test("save back blocks unresolved claims including translations and honors limits", () => {
  const context = tailorFixture(); context.text.origin = "ai";
  context.doc.claims = [claim(context.text.id, { translation: true })];
  expect(() => saveBack(context.doc, context.profile, context.text.id, undefined, context.settings)).toThrow("unresolved_claims");
  const confirmed = confirmTranslation(context.doc);
  expect(() => saveBack(confirmed, context.profile, context.text.id, undefined, context.settings)).not.toThrow();
  context.doc.claims = [];
  context.text.text = "A new wording"; context.settings.profile.max_wordings_per_text = 1;
  expect(() => saveBack(context.doc, context.profile, context.text.id, undefined, context.settings)).toThrow("limits");
});

test("save back stores a wording with provenance and no matching profile side effects", async () => {
  temp = tempCareer();
  const savedProfile = await saveCareerProfile(profile("Built services"), { baseHash: null });
  expect(savedProfile.ok).toBe(true);
  const loaded = await loadCareerProfile();
  const context = tailorFixture();
  context.doc.experience[0]!.bullets[0]!.source = { text_id: loaded.profile.experience[0]!.bullets[0]!.id, wording_id: loaded.profile.experience[0]!.bullets[0]!.primary };
  context.text.text = "Built useful services"; context.text.origin = "user";
  const created = await createDocument(context.doc);
  const result = await saveBackToProfile(context.doc.id, context.text.id, { baseHash: created.baseHash });
  expect(result.ok).toBe(true);
  const current = await loadCareerProfile();
  expect(current.profile.experience[0]!.bullets[0]!.wordings).toContainEqual(expect.objectContaining({ text: context.text.text, origin: "from_document", from_document: context.doc.id }));
  const after = (await loadDocument(context.doc.id)).document;
  expect(after.experience[0]!.bullets[0]!.origin).toBe("source");
  const bytes = fs.readFileSync(careerProfilePath(), "utf8");
  await expect(saveBackToProfile(context.doc.id, context.text.id, { baseHash: created.baseHash })).resolves.toMatchObject({ ok: false, code: "stale" });
  expect(fs.readFileSync(careerProfilePath(), "utf8")).toBe(bytes);
});

test("claim rejection then removal permits confirmed status", () => {
  const context = tailorFixture();
  context.doc.claims = [claim(context.text.id), claim(context.text.id, { text: "Kafka" })];
  const confirmed = decideClaim(context.doc, context.doc.claims[1]!.id, "confirmed");
  confirmed.claims = confirmed.claims.slice(1);
  expect(markOf(context.text, confirmed.claims)).toBe("confirmed");
});

test("skill additions have field targets and remain flagged after an unrelated edit", () => {
  const context = tailorFixture();
  const group = { id: newId("ent"), source: null, included: true, group: "Tools", items: [] };
  context.doc.skills.push(group); context.sentIds.push(group.id);
  const item = proposal(context, { target: { list: `${group.id}.items` }, text: "kubernetes" });
  expect(item.claims).toContainEqual(expect.objectContaining({ target: { entry: group.id, field: "skills", value: "kubernetes" } }));
  const applied = applyProposal(context.doc, item, context.settings).document;
  const saved = rerunClaims(applied, { ...applied, title: "Changed" }, context.profile, context.settings);
  expect(saved.claims.some((claim) => claim.status === "pending" && claim.kind === "skill")).toBe(true);
  expect(saved.skills[0]!.items).toHaveLength(1);
});

test("a replacement rewrite removes obsolete claims without losing AI origin", () => {
  const context = tailorFixture();
  context.text.text = "Improved latency 40%"; context.text.origin = "ai";
  context.doc.claims = [claim(context.text.id, { status: "rejected" })];
  const item = proposal(context, { action: "rewrite", target: { text: context.text.id }, text: "Reduced nightly batch time", support: [{ quote: "Reduced nightly batch time" }] });
  const applied = applyProposal(context.doc, item, context.settings).document;
  expect(applied.claims).toEqual([]);
  expect(applied.experience[0]!.bullets[0]!.origin).toBe("ai");
});

test("source-less save-back retries reuse a committed profile text", () => {
  const context = tailorFixture(); context.text.source = null; context.text.text = "A new manual bullet";
  const entry = context.profile.experience[0]!;
  const first = saveBack(context.doc, context.profile, context.text.id, entry.id, context.settings);
  const second = saveBack(context.doc, first.profile, context.text.id, entry.id, context.settings);
  expect(second.profile.experience[0]!.bullets).toHaveLength(2);
});

test("identical manual texts saved to different entries keep the selected source", async () => {
  temp = tempCareer();
  const draft = profile("Original bullet"); draft.experience.push(profile("Another original").experience[0]!);
  const savedProfile = await saveCareerProfile(draft, { baseHash: null });
  if (!savedProfile.ok) throw new Error("fixture save failed");
  const context = tailorFixture(); context.text.source = null; context.text.text = "Identical manual text";
  const second = { ...context.text, id: newId("dtx") };
  context.doc.experience[0]!.bullets.push(second);
  const created = await createDocument(context.doc);
  const first = await saveBackToProfile(context.doc.id, context.text.id, { baseHash: created.baseHash, target: savedProfile.profile.experience[1]!.id });
  if (!first.ok) throw new Error("fixture save failed");
  const result = await saveBackToProfile(context.doc.id, second.id, { baseHash: first.baseHash, target: savedProfile.profile.experience[0]!.id });
  if (!result.ok) throw new Error("fixture save failed");
  const profileAfter = (await loadCareerProfile()).profile;
  expect(profileAfter.experience[0]!.bullets.some((text) => text.id === result.document.experience[0]!.bullets[1]!.source?.text_id)).toBe(true);
});

test("document saves enforce instruction limits for raw YAML edits too", async () => {
  temp = tempCareer({ tailor: { max_requirements: 1, requirement_max_chars: 20 } });
  const context = tailorFixture(); const created = await createDocument(context.doc);
  await expect(saveDocument(context.doc.id, { ...context.doc, requirements: ["First", "Second"] }, { baseHash: created.baseHash })).rejects.toMatchObject({ code: "limits" });
  expect((await loadDocument(context.doc.id)).baseHash).toBe(created.baseHash);
});

test("deleting one word of a merged JD-only claim keeps the remaining words pending", () => {
  const context = tailorFixture(); context.text.origin = "ai";
  context.text.text = "Built services with kubernetes redis";
  context.doc.claims = [claim(context.text.id, { kind: "skill", text: "kubernetes, redis", in_jd: true })];
  const before = structuredClone(context.doc);
  context.text.text = "Built services with kubernetes";
  const after = rerunClaims(before, context.doc, context.profile, context.settings);
  expect(after.claims).toEqual([expect.objectContaining({ text: "kubernetes", status: "pending", in_jd: true })]);
  expect(() => saveBack(after, context.profile, context.text.id, undefined, context.settings)).toThrow("unresolved_claims");
});

test("save back keeps wordings that differ only in punctuation apart", () => {
  const context = tailorFixture("Built tools in C++");
  context.doc.claims = []; context.text.origin = "user"; context.text.text = "Built tools in C#";
  const result = saveBack(context.doc, context.profile, context.text.id, undefined, context.settings);
  expect(result.wording.text).toBe("Built tools in C#");
  expect(result.source.wordings.map((wording) => wording.text)).toEqual(["Built tools in C++", "Built tools in C#"]);
});
