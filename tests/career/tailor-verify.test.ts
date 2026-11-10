import { describe, expect, test } from "vitest";
import { verifyProposal } from "@/lib/career/tailor/verify";
import { confirmTranslation, rerunClaims } from "@/lib/career/document/claims";
import { markOf } from "@/lib/career/document/marks";
import { proposalInputSchema } from "@/lib/career/tailor/proposal-schema";
import { tailorFixture } from "./tailor-fixtures";

function check(text: string, pool?: string, patch: Record<string, unknown> = {}) {
  const context = tailorFixture(pool);
  const input = proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text, ...patch });
  return verifyProposal(input, context)!;
}

describe("tailoring evidence", () => {
  test.each([["40%", "Reduced errors"], ["40 %", "Reduced errors 40 Prozent"], ["1,200", "Served 1.200 users"]])("checks equivalent figures %s", (text, pool) => {
    expect(check(text, pool).claims.some((claim) => claim.kind === "figure")).toBe(pool === "Reduced errors");
  });
  test("uses the same entry for numbers and the complete pool for skills", () => {
    const context = tailorFixture("Improved latency");
    context.pool.all += " 40% Kafka";
    expect(verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text: "Improved latency 40% with Kafka" }), context)?.claims).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "figure" })]));
    expect(check("headline 40%", "40%", { support: [{ quote: "40%" }] }).claims.some((claim) => claim.kind === "figure")).toBe(false);
  });
  test("detects duties without numbers or names and insufficient support", () => {
    expect(check("Led a cross-functional team").claims).toContainEqual(expect.objectContaining({ kind: "duty" }));
    expect(check("Led a cross-functional team", undefined, { support: [{ quote: "Reduced nightly batch time" }] }).claims).toContainEqual(expect.objectContaining({ kind: "duty" }));
    expect(check("Reduced nightly batch time", undefined, { support: [{ quote: "Not in source" }] }).claims).toContainEqual(expect.objectContaining({ kind: "duty" }));
    expect(check("Reduced nightly batch time", undefined, { support: [{ quote: "Reduced nightly batch time" }] }).claims).toEqual([]);
  });
  test("catches lower-case skills and German single capitalized nouns in the JD", () => {
    expect(check("Used kubernetes and kafka").claims).toContainEqual(expect.objectContaining({ kind: "skill", in_jd: true, text: "kubernetes, kafka" }));
    const context = tailorFixture(); context.doc.layout.lang = "de";
    expect(verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text: "Erfahrung mit Kafka" }), context)?.claims).toContainEqual(expect.objectContaining({ kind: "skill", in_jd: true, text: "kafka" }));
  });
  test("adds a skill claim for stack and skill items even without a JD", () => {
    const context = tailorFixture(); context.jd = "";
    expect(verifyProposal(proposalInputSchema.parse({ action: "add", target: { entry: context.doc.experience[0]!.id, field: "stack" }, text: "kubernetes" }), context)?.claims).toContainEqual(expect.objectContaining({ kind: "skill", translation: false }));
  });
  test("shorten requires no support for subsets and checks new duties otherwise", () => {
    expect(check("Reduced batch time", undefined, { action: "shorten" }).claims).toEqual([]);
    expect(check("Led a team", undefined, { action: "shorten" }).claims).toContainEqual(expect.objectContaining({ kind: "duty" }));
  });
  test("letter paragraphs reference sent entries without lexical coverage", () => {
    const context = tailorFixture();
    const input = proposalInputSchema.parse({ action: "add", target: { list: "letter.body" }, text: "I enjoy building useful services", support: [{ entry: context.sentIds[0] }] });
    expect(verifyProposal(input, context)?.claims).toEqual([]);
    input.support = [{ entry: "missing" }];
    expect(verifyProposal(input, context)).toBeNull();
    input.support = [];
    expect(verifyProposal(input, context)?.claims).toContainEqual(expect.objectContaining({ kind: "duty", translation: false }));
    const field = verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { letter: "subject" }, text: "Application 40%" }), context)!;
    expect(field.claims[0]?.target).toEqual({ letter: "subject" });
  });
  test("job title company and recipient names are exempt", () => {
    const context = tailorFixture(); context.doc.job = { id: 1, company: "Example Labs", title: "Platform Engineer", jd_hash: "hash" };
    const item = verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { letter: "subject" }, text: "Application: Platform Engineer at Example Labs" }), context)!;
    expect(item.claims).toEqual([]);
  });
  test.each(["[email]", "[work_auth]", "[availability]", "[salary]"])("drops placeholders %s", (value) => {
    expect(check(value)).toBeNull();
  });
  test("drops unknown ids invalid actions and impossible reorders", () => {
    const context = tailorFixture();
    expect(verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: "missing" }, text: "text" }), context)).toBeNull();
    expect(verifyProposal(proposalInputSchema.parse({ action: "add", target: { text: context.text.id }, text: "text" }), context)).toBeNull();
    context.allowed = ["drop"] as unknown as typeof context.allowed;
    expect(verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text: "text" }), context)).toBeNull();
  });
});

test("translation confirmation only resolves translation duties and JD terms", () => {
  const context = tailorFixture(); context.doc.layout.lang = "de";
  const item = verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text: "Verbesserte Kafka mit kubernetes um 72%" }), context)!;
  expect(item.claims).toContainEqual(expect.objectContaining({ kind: "duty", translation: true }));
  expect(item.claims).toContainEqual(expect.objectContaining({ text: "kafka, kubernetes", translation: true }));
  expect(item.claims).toContainEqual(expect.objectContaining({ kind: "figure", translation: false }));
  context.doc.claims = item.claims; context.text.origin = "ai";
  expect(markOf(context.text, context.doc.claims)).toBe("unverified");
  const confirmed = confirmTranslation(context.doc);
  expect(confirmed.claims.filter((claim) => claim.translation).every((claim) => claim.status === "confirmed")).toBe(true);
  expect(confirmed.claims.filter((claim) => !claim.translation).every((claim) => claim.status === "pending")).toBe(true);
  context.profile.experience[0]!.bullets[0]!.wordings[0]!.lang = null;
  expect(verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text: "Neuer Text" }), context)?.claims.every((claim) => !claim.translation)).toBe(true);
});

test("edits preserve surviving claims and add only noted user facts", () => {
  const context = tailorFixture();
  const item = check("Reduced errors 40% and kubernetes", "Reduced errors");
  context.text.text = item.text!; context.text.origin = "ai";
  context.doc.claims = item.claims.map((claim) => ({ ...claim, target: { text: context.text.id }, status: "rejected" }));
  let edited = structuredClone(context.doc); edited.experience[0]!.bullets[0]!.text += "!";
  edited = rerunClaims(context.doc, edited, context.profile, context.settings);
  expect(edited.claims.some((claim) => claim.status === "rejected")).toBe(true);
  edited.experience[0]!.bullets[0]!.text = "Reduced errors 75%";
  const next = rerunClaims(context.doc, edited, context.profile, context.settings);
  expect(next.claims.some((claim) => claim.text.includes("40"))).toBe(false);
  expect(next.claims.some((claim) => claim.kind === "figure" && claim.by === "user" && claim.status === "noted")).toBe(true);
  expect(next.claims.some((claim) => claim.kind === "duty")).toBe(false);
});

test("unknown references and unsent text targets are dropped", () => {
  const context = tailorFixture();
  const input = proposalInputSchema.parse({ action: "add", target: { list: `${context.doc.experience[0]!.id}.bullets` }, text: "A paragraph", after: "private sentinel" });
  expect(verifyProposal(input, context)).toBeNull();
  input.after = null; input.support = [{ entry: context.sentIds[0]! }, { entry: "private sentinel" }];
  expect(verifyProposal(input, context)).toBeNull();
  input.support = [{ entry: "emphasis" }]; context.sentIds.push("emphasis");
  expect(verifyProposal(input, context)).toBeNull();
  const rewrite = proposalInputSchema.parse({ action: "rewrite", target: { text: context.text.id }, text: "Reduced batch time" });
  context.sentIds = [];
  expect(verifyProposal(rewrite, context)).toBeNull();
});

test("new bullets use their source entry pool and recipient metadata is exempt", () => {
  const context = tailorFixture("Built a service"); context.pool.all += " Cut costs 40%";
  const input = proposalInputSchema.parse({ action: "add", target: { list: `${context.doc.experience[0]!.id}.bullets` }, text: "Cut costs 40%", support: [{ quote: "Cut costs 40%" }] });
  expect(verifyProposal(input, context)?.claims).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "figure" }), expect.objectContaining({ kind: "duty" })]));
  const recipient = proposalInputSchema.parse({ action: "rewrite", target: { letter: "recipient" }, text: "Ada Example" });
  expect(verifyProposal(recipient, context)?.claims).toEqual([]);
  expect(verifyProposal(proposalInputSchema.parse({ action: "drop", target: { text: context.doc.experience[0]!.role.id } }), context)).toBeNull();
});
