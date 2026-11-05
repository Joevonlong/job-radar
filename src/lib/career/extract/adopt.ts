import { z } from "zod";

import { CareerStoreError } from "../contact/errors";
import { careerProfileSchema, primaryText, type CareerProfile, type Text } from "../schema/profile";
import type { CareerDraft } from "./draft-store";
import { matchCareerEntry, normalizeCareerContent } from "./match";
import { DRAFT_FIELDS, DRAFT_SECTIONS, type DraftEntry } from "./verify";

export const adoptDecisionsSchema = z.array(z.strictObject({
  key: z.string().regex(/^(?:headline|summary|d\d+(?:\.\d+)*)$/), action: z.enum(["skip", "new", "merge"]),
  target: z.string().min(1).max(100).optional(), fields: z.partialRecord(z.enum(DRAFT_FIELDS), z.string().max(20000).nullable()).optional(),
  bullets: z.array(z.string().max(20000)).max(100).optional(),
})).max(1000).superRefine((decisions, context) => {
  if (new Set(decisions.map((decision) => decision.key)).size !== decisions.length) context.addIssue({ code: "custom", message: "duplicate decision" });
});
export type AdoptDecisions = z.infer<typeof adoptDecisionsSchema>;

/** Adoption adds reviewed content and alternate wordings; existing factual fields remain authoritative. */
export function adoptDraft(profile: CareerProfile, draft: CareerDraft, decisions: AdoptDecisions): CareerProfile {
  const result = structuredClone(profile);
  const choose = new Map(adoptDecisionsSchema.parse(decisions).map((decision) => [decision.key, decision]));
  const text = (value: string): Text => ({ id: "", primary: "", wordings: [{ id: "", text: value, lang: draft.language, label: null, origin: "extracted", from_document: null, from_story: null, created_at: draft.created_at }] });
  const wording = (current: Text | null, value: string): Text | null => {
    if (!value.trim()) return current;
    if (!current) return text(value);
    if (!current.wordings.some((item) => normalizeCareerContent(item.text) === normalizeCareerContent(value))) current.wordings.push(text(value).wordings[0]!);
    return current;
  };
  const bullets = (current: Text[], values: string[]) => {
    for (const value of values) if (value.trim() && !current.some((item) => item.wordings.some((item) => normalizeCareerContent(item.text) === normalizeCareerContent(value)))) current.push(text(value));
    return current;
  };
  for (const key of ["headline", "summary"] as const) {
    const decision = choose.get(key);
    choose.delete(key);
    if (!decision || decision.action === "skip") continue;
    const value = decision.fields?.text ?? draft.sections[key]?.value;
    if (value) result[key] = wording(result[key], value);
  }
  for (const section of DRAFT_SECTIONS) for (const original of draft.sections[section]) {
    const decision = choose.get(original.key);
    if (!decision) continue;
    choose.delete(original.key);
    if (decision.action === "skip") continue;
    const entry: DraftEntry = structuredClone(original);
    for (const [key, value] of Object.entries(decision.fields ?? {})) entry.fields[key as typeof DRAFT_FIELDS[number]] = value == null ? null : { value, quote: "", flags: [] };
    const v = (key: typeof DRAFT_FIELDS[number]) => entry.fields[key]?.value ?? "";
    const nullable = (key: typeof DRAFT_FIELDS[number]) => v(key) || null;
    const bs = decision.bullets ?? entry.bullets.map((field) => field.value);
    const stack = entry.stack.map((field) => field.value);
    const inferred = result[section].findIndex((candidate) => matchCareerEntry({ ...result, [section]: [candidate] }, section, entry) !== null);
    const explicit = decision.action === "merge" ? decision.target ?? entry.match : null;
    const target = explicit ? result[section].findIndex((item) => item.id === explicit) : inferred;
    if (decision.action === "merge" && target < 0) throw new CareerStoreError("unknown_id");
    if (section === "experience") {
      const old = result.experience[target];
      if (old) { wording(old.role, v("role")); old.summary = wording(old.summary, v("summary")); bullets(old.bullets, bs); }
      else result.experience.push({ id: "", company: v("company"), role: text(v("role")), url: null, location: nullable("location"), start: nullable("start"), end: nullable("end"), summary: v("summary") ? text(v("summary")) : null, bullets: bullets([], bs), stack });
    } else if (section === "projects") {
      const old = result.projects[target];
      if (old) { old.tagline = wording(old.tagline, v("tagline")); bullets(old.bullets, bs); }
      else result.projects.push({ id: "", name: v("name"), url: null, tagline: v("tagline") ? text(v("tagline")) : null, bullets: bullets([], bs), stack });
    } else if (section === "education") {
      const old = result.education[target];
      if (old) { wording(old.degree, v("degree")); old.summary = wording(old.summary, v("summary")); bullets(old.bullets, bs); }
      else result.education.push({ id: "", school: v("school"), degree: text(v("degree")), url: null, location: nullable("location"), start: nullable("start"), end: nullable("end"), summary: v("summary") ? text(v("summary")) : null, bullets: bullets([], bs) });
    } else if (section === "certifications") {
      if (target < 0) result.certifications.push({ id: "", name: v("name"), issuer: nullable("issuer"), date: nullable("date") });
    } else if (section === "languages") {
      if (target < 0) result.languages.push({ id: "", name: v("name"), level: v("level"), code: null, cefr: null });
    } else if (section === "skills") {
      let group = result.skills[target];
      if (!group) { group = { id: "", group: v("group"), items: [] }; result.skills.push(group); }
      for (const item of entry.items) {
        const name = item.fields.name?.value ?? "";
        if (name && !group.items.some((item) => normalizeCareerContent(item.name) === normalizeCareerContent(name))) group.items.push({ id: "", name, years: null });
      }
    } else {
      let custom = result.custom_sections[target];
      if (!custom) { custom = { id: "", title: text(v("title")), layout: "list", side: "main", items: [] }; result.custom_sections.push(custom); }
      for (const item of entry.items) {
        const f = (key: typeof DRAFT_FIELDS[number]) => item.fields[key]?.value ?? "";
        const heading = f(item.kind === "text" ? "text" : "heading");
        if (item.kind === "text") {
          if (!custom.items.some((candidate) => candidate.kind !== "entry" && normalizeCareerContent(primaryText(candidate.text)) === normalizeCareerContent(heading))) custom.items.push({ id: "", kind: "text", text: text(heading) });
          for (const bullet of item.bullets) {
            if (custom.items.some((candidate) => candidate.kind !== "entry" && normalizeCareerContent(primaryText(candidate.text)) === normalizeCareerContent(bullet.value))) continue;
            custom.items.push({ id: "", kind: "bullet", text: text(bullet.value) });
          }
          continue;
        }
        const existing = custom.items.find((candidate) => candidate.kind === "entry" ? normalizeCareerContent(primaryText(candidate.heading)) === normalizeCareerContent(heading) && candidate.date === (f("date") || null) : normalizeCareerContent(primaryText(candidate.text)) === normalizeCareerContent(heading));
        if (existing?.kind === "entry") { wording(existing.heading, heading); existing.sub = wording(existing.sub, f("sub")); existing.text = wording(existing.text, f("text")); bullets(existing.bullets, item.bullets.map((field) => field.value)); continue; }
        if (existing) continue;
        custom.items.push({ id: "", kind: "entry", heading: text(heading), sub: f("sub") ? text(f("sub")) : null, url: null, date: f("date") || null, start: null, end: null, location: null, tags: [], text: f("text") ? text(f("text")) : null, bullets: bullets([], item.bullets.map((field) => field.value)) });
      }
    }
  }
  if (choose.size) throw new CareerStoreError("draft_invalid");
  return careerProfileSchema.parse(result);
}
