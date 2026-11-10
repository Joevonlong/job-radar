import fs from "node:fs";
import path from "node:path";

import { careerSchema } from "@/lib/config/schemas/career";
import { assignIds } from "@/lib/career/schema/ids";
import { careerProfileSchema, emptyProfile, type CareerProfile } from "@/lib/career/schema/profile";
import { generateDocument } from "@/lib/career/document/generate";
import { parseResume } from "@/lib/career/engine/render";
import { text } from "./fixtures";

export const NOW = "2026-01-02T03:04:05Z";
export const HASH = "a".repeat(64);
export const defaults = () => careerSchema.parse({ document: { defaults: { lang: "en", theme: "classic", accent: "#123456", pages: 2, paper: "letter", density: "relaxed" } } }).document.defaults;

export function richProfile(): CareerProfile {
  const parsed = parseResume(fs.readFileSync(path.join(import.meta.dirname, "../fixtures/career/sample.en.yaml"), "utf8"));
  if (!parsed.ok) throw new Error("invalid fixture");
  const sample = parsed.resume;
  const draft = careerProfileSchema.parse({
    headline: text(sample.basics.title), summary: text(sample.basics.summary),
    experience: sample.experience.map((entry) => ({ ...entry, id: "", role: text(entry.role), summary: entry.summary ? text(entry.summary) : null, bullets: entry.bullets.map((value) => text(value)) })),
    projects: sample.projects.map((entry) => ({ ...entry, id: "", tagline: entry.tagline ? text(entry.tagline) : null, bullets: entry.bullets.map((value) => text(value)) })),
    education: sample.education.map((entry) => ({ ...entry, id: "", degree: text(entry.degree), summary: entry.summary ? text(entry.summary) : null, bullets: entry.bullets.map((value) => text(value)) })),
    skills: sample.skills.map((group) => ({ id: "", group: group.group, items: group.items.map((name) => ({ id: "", name })) })),
    languages: sample.languages.map((entry) => ({ ...entry, id: "" })),
    approach: sample.approach.map((entry) => ({ ...entry, id: "", text: text(entry.text) })),
    certifications: [{ id: "", name: "Example certification", issuer: "Example institute", date: "2020" }],
    custom_sections: [
      { id: "", title: text("Selected work"), layout: "list", side: "main", items: [{ id: "", kind: "entry", heading: text("Example"), sub: text("Subheading"), start: "2020", end: "2021", text: text("Details"), tags: ["TypeScript:blue"], bullets: [text("Delivered")] }] },
      { id: "", title: text("Notes"), layout: "list", side: "aside", items: [{ id: "", kind: "text", text: text("A note") }] },
      { id: "", title: text("Highlights"), layout: "grid", side: "main", items: [{ id: "", kind: "bullet", text: text("A highlight") }] },
      { id: "", title: text("Tags"), layout: "tags", side: "aside", items: [{ id: "", kind: "tag", text: text("Example:green") }] },
    ],
  });
  return assignIds(draft, emptyProfile());
}
export function document() {
  return generateDocument(richProfile(), HASH, defaults(), NOW, "Example document");
}
