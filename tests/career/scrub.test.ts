import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { confirmedOutbound, toOutbound } from "@/lib/career/ai/outbound";
import { careerAiView } from "@/lib/career/ai/view";
import { prepareCareerScrub } from "@/lib/career/contact/scrub";
import { saveContact } from "@/lib/career/contact/store";
import { emptyContact } from "@/lib/career/schema/contact";
import { tempCareer, profile, text } from "./fixtures";
import { settings } from "./extract-fixtures";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => { temp = tempCareer({ import: { stored_value_min_chars: 3 } }); });
afterEach(() => temp.cleanup());
it("replaces stored identity values with word boundaries, reversed names and flexible whitespace", async () => {
  await saveContact({ ...emptyContact(), name: "Al Example", address: "Sample Street 1", email: "private@example.test", phone: "0151 12345678", work_auth: "EU", availability: "Now", location: "Sampletown", links: [{ label: "Site", url: "https://local.example.test" }] }, { baseHash: null });
  const source = "AL  Example / Example Al / Sample  Street 1 / private@example.test / 0151 12345678 / EU / Now / Sampletown / https://local.example.test";
  const result = prepareCareerScrub(source, { rules: settings().import, mode: "values" });
  expect(result.text).toBe("[name] / [name] / [address] / [email] / [phone] / EU / [availability] / Sampletown / [link]");
  expect(result.highlights.map((span) => result.text.slice(span.start, span.end))).toEqual(expect.arrayContaining(["EU", "Sampletown"]));
  expect(toOutbound(result.text)).toBe(result.text);
  expect(() => confirmedOutbound(source)).toThrow(expect.objectContaining({ code: "scrub_mismatch" }));
});
it("short identity names do not replace parts of other words", async () => {
  await saveContact({ ...emptyContact(), name: "Al", work_auth: "EU" }, { baseHash: null });
  expect(toOutbound("Al Also EU NEU")).toBe("[name] Also EU NEU");
});
it("strips every URL from profile projection and scrubs all wording and label content", () => {
  const p = profile("private@example.test");
  p.summary = text("private@example.test");
  p.experience[0]!.url = "https://profile.example.test";
  p.experience[0]!.role.wordings[0]!.label = "private@example.test";
  p.projects.push({ id: "", name: "private@example.test", url: "https://project.example.test", tagline: text("private@example.test"), stack: ["private@example.test"], bullets: [] });
  p.custom_sections.push({ id: "", title: text("private@example.test"), layout: "list", side: "main", items: [] });
  const value = toOutbound(careerAiView(p));
  expect(value).not.toContain("private@example.test");
  expect(value).not.toContain(".example.test");
});
it("isolates parser diagnostics without a cause", () => {
  fs.mkdirSync(path.join(temp.profileDir, "career"), { recursive: true });
  fs.writeFileSync(path.join(temp.profileDir, "career/contact.yaml"), "name: [private-marker");
  expect(() => toOutbound("source")).toThrow(expect.objectContaining({ code: "contact_invalid" }));
});

it("scrubs raw whitespace and quotes from every projected wording before encoding can hide them", async () => {
  await saveContact({ ...emptyContact(), name: "Private Person", address: 'Sample "Road" 7' }, { baseHash: null });
  const p = profile('Private\nPerson at Sample "Road"\t7');
  p.summary = text("Private\tPerson");
  p.experience[0]!.role.wordings.push({ ...p.experience[0]!.role.wordings[0]!, text: "Private\nPerson" });
  const result = toOutbound(careerAiView(p));
  expect(result).not.toContain("Private");
  expect(result).not.toContain("Road");
});
