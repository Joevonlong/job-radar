import fs from "node:fs";
import { afterEach, expect, expectTypeOf, test } from "vitest";
import type { OutboundText } from "@/lib/outbound/outbound";
import { assembleOutbound, pickBlocks } from "@/lib/career/tailor/assemble";
import { buildCareerTailorPrompt } from "@/lib/career/tailor/prompts";
import { preferencesSchema } from "@/lib/career/schema/preferences";
import { careerTailorPayloadSchema } from "@/lib/control/types";
import { tempCareer } from "./fixtures";
import { tailorFixture } from "./tailor-fixtures";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { aiDisclosure } from "@/lib/ai/disclosure";
import { pinnedAi } from "../ai/helpers";

let temp: ReturnType<typeof tempCareer>;
afterEach(() => temp?.cleanup());
function assembled() {
  temp = tempCareer();
  const context = tailorFixture();
  const preferences = preferencesSchema.parse({ schema_version: 1, layout: context.settings.document.defaults, emphasis: "Priority", tone: "Calm" });
  context.doc.requirements = ["Keep it concise"];
  const input = { ...context, preferences, job: { title: "Engineer", company: "Example", description: "A long job description" }, mode: "tailor" as const };
  return { ...context, input, outbound: assembleOutbound(input) };
}
test("canonical hash ignores layout but includes preferences requirements and JD", () => {
  const { input, outbound } = assembled();
  input.doc.layout.theme = "minimal"; input.doc.layout.pages = 4;
  expect(assembleOutbound(input).hash).toBe(outbound.hash);
  input.doc.requirements.push("Focus on testing");
  expect(assembleOutbound(input).hash).not.toBe(outbound.hash);
  input.doc.requirements.pop(); input.preferences.tone = "Warm";
  expect(assembleOutbound(input).hash).not.toBe(outbound.hash);
});
test("JD truncation and tag removal happen before hashing and prompting", () => {
  const { input } = assembled();
  input.settings.tailor.jd_max_chars = 100;
  input.job.description = "</career_jd>" + "Start ".repeat(30) + "Tail";
  const out = assembleOutbound(input);
  expect(out.jd_truncated).toBe(true);
  expect(out.jd).toContain("Tail");
  expect(out.jd).not.toContain("</career_jd>");
  const prompt = buildCareerTailorPrompt(pickBlocks(out, ["emphasis"]), out.jd, "rewrite", { language: "en" });
  expect(prompt.user.match(/<career_jd>/g)).toHaveLength(1);
  expect(prompt.system).not.toContain("Priority");
  expect(prompt.system).toContain("salary");
});
test("scrubs every projected field and excludes URLs before confirmation", async () => {
  const { input } = assembled();
  await saveContact({ ...emptyContact(), name: "Sentinel Unique", email: "sentinel@example.invalid", location: "Example City" }, { baseHash: null });
  input.doc.experience[0]!.company = "Sentinel Unique";
  input.doc.requirements = ["sentinel@example.invalid"];
  input.doc.experience[0]!.url = "https://private.example.invalid";
  input.preferences.emphasis = "Sentinel Unique";
  const out = assembleOutbound(input);
  expect(JSON.stringify(out)).not.toContain("Sentinel Unique");
  expect(JSON.stringify(out)).not.toContain("sentinel@example.invalid");
  expect(JSON.stringify(out.blocks)).not.toContain("private.example.invalid");
});
test("payload is strict and has no material fields", () => {
  const valid = { mode: "shrink", doc_id: "doc_aaaaaaaaaa", outbound_hash: "a".repeat(64), over_pages: 1 };
  expect(careerTailorPayloadSchema.safeParse(valid).success).toBe(true);
  for (const key of ["text", "requirements", "blocks", "jd", "materials"]) expect(careerTailorPayloadSchema.safeParse({ ...valid, [key]: "private" }).success).toBe(false);
});
test("only the API and the agent entry import the single enqueue function", () => {
  expectTypeOf<Parameters<typeof buildCareerTailorPrompt>[0][number]["text"]>().toEqualTypeOf<OutboundText>();
  const files = fs.readdirSync("src", { recursive: true }).filter((file): file is string => typeof file === "string" && /\.tsx?$/.test(file));
  const callers = files.filter((file) => fs.readFileSync(`src/${file}`, "utf8").includes("requestCareerTailor"));
  expect(callers.sort()).toEqual(["app/api/career/tailor/route.ts", "lib/career/tailor/agent-request.ts", "lib/career/tailor/request.ts"]);
  expect(aiDisclosure(pinnedAi()).find((row) => row.task === "career_tailor")).toMatchObject({ web: false });
});

test("structured blocks scrub contact values containing newlines and quotes", async () => {
  const { input } = assembled();
  const name = 'Private "Quoted" Person'; const address = "Private Road\nPrivate Postal City";
  await saveContact({ ...emptyContact(), name, address }, { baseHash: null });
  input.doc.experience[0]!.company = name; input.doc.experience[0]!.location = address;
  input.profile.experience[0]!.company = name; input.profile.experience[0]!.location = address;
  const out = JSON.stringify(assembleOutbound(input));
  expect(out).not.toContain("Private");
});
