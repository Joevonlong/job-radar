import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/career/store/images", () => ({ loadImages: async () => ({}) }));
vi.mock("@/lib/dashboard/context", () => ({ getDisplayTimeZone: () => "UTC" }));

import { POST as preview } from "@/app/api/career/documents/preview/route";
import { check_career_document } from "@/lib/capabilities/career/check-career-document";
import { list_career_documents } from "@/lib/capabilities/career/list-career-documents";
import { mcpSchema } from "@/lib/config/schemas/mcp";
import type { Db } from "@/lib/db/client";
import { checkCareerDocumentOutput } from "@/lib/mcp/dto";
import { defaultContext } from "@/lib/mcp/server";
import { document } from "../career/document-fixtures";
import { tempCareer } from "../career/fixtures";
import { contactSentinels, sentinels } from "../career/redaction-fixtures";

let temp: ReturnType<typeof tempCareer>;
let doc: ReturnType<typeof document>;
beforeEach(() => {
  temp = tempCareer();
  doc = document();
  doc.letter = {
    recipient: [], place: null, date: null, subject: null, salutation: null, closing: null,
    body: [{ id: "dtx_zzzzzzzzzz", source: null, origin: "user", text: "An independent letter paragraph" }],
  };
  fs.mkdirSync(path.join(temp.profileDir, "career/documents"), { recursive: true });
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify(contactSentinels));
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); temp.cleanup(); });

function context() {
  const ctx = defaultContext({} as Db, mcpSchema.parse({}));
  ctx.now = () => new Date("2026-01-15T12:00:00Z");
  ctx.timezone = () => "UTC";
  return ctx;
}

async function check(kind: "resume" | "letter") {
  fs.writeFileSync(path.join(temp.profileDir, `career/documents/${doc.id}.yaml`), stringify(doc));
  return checkCareerDocumentOutput.parse(await check_career_document.handler(context(), { id: doc.id, doc: kind }));
}

it.each(["resume", "letter"] as const)("calculates %s font coverage only after scrubbing the complete text", async (kind) => {
  const name = "张三丰";
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify({ ...contactSentinels, name }));
  doc.headline!.text = `${name} 中文`;
  doc.letter!.body[0]!.text = `${name} 中文`;
  const result = await check(kind);
  expect(result.text).toContain("[name]");
  expect(result.uncovered).toEqual(["中", "文"]);
  expect(result.exportHints?.uncovered).toEqual(["中", "文"]);
  for (const character of name) {
    expect(result.uncovered).not.toContain(character);
    expect(result.exportHints?.uncovered).not.toContain(character);
    expect(result.text).not.toContain(character);
  }
});

it.each(["resume", "letter"] as const)("matches web %s finding codes without returning contact or text fragments", async (kind) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(context().now());
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), stringify({ ...contactSentinels, phone: "0555 87654321" }));
  doc.experience[0]!.bullets[0]!.text = `${"x".repeat(40)} ${contactSentinels.name} ${"x".repeat(200)}`;
  const result = await check(kind);
  const response = await preview(new Request("http://localhost/api/career/documents/preview", {
    method: "POST", body: JSON.stringify({ document: doc, doc: kind }),
  }));
  expect(response.status).toBe(200);
  const web = await response.json();
  const codes = (items: { code: string }[]) => items.map(({ code }) => code).sort();
  expect(codes(result.findings)).toEqual(codes(web.findings));
  expect(codes(result.exportHints!.findings)).toEqual(codes(web.exportHints.findings));
  expect(codes(result.exportHints!.findings)).toContain("career.lint.phone_country");
  const findings = [...result.findings, ...result.exportHints!.findings];
  for (const sentinel of [...sentinels, "0555 87654321", "Fictional"]) expect(JSON.stringify(findings)).not.toContain(sentinel);
  for (const finding of findings) expect(Object.values(finding.params).every((value) => typeof value === "number")).toBe(true);
});

it("reads each listed document only once while returning its linked job", async () => {
  doc.job = { id: 123, company: "Example", title: "Engineer", jd_hash: "a".repeat(64) };
  const file = path.join(temp.profileDir, `career/documents/${doc.id}.yaml`);
  fs.writeFileSync(file, stringify(doc));
  const read = vi.spyOn(fs, "readFileSync");
  const result = await list_career_documents.handler(context(), {});
  expect(result.documents).toMatchObject([{ id: doc.id, jobId: 123, status: "ok" }]);
  expect(read.mock.calls.filter(([name]) => String(name) === file)).toHaveLength(1);
});
