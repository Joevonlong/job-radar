import { z } from "zod";

import { CareerStoreError } from "../contact/errors";
import { careerProfileSchema, primaryText, type CareerProfile, type CustomSection, type Text } from "../schema/profile";
import type { CareerDraft } from "./draft-store";
import { normalizeCareerContent } from "./match";
import { DRAFT_FIELDS, DRAFT_SECTIONS, type DraftEntry } from "./verify";

export const adoptDecisionsSchema = z.array(z.strictObject({
  key: z.string().regex(/^(?:headline|summary|d\d+(?:\.\d+)*)$/),
  action: z.enum(["skip", "new", "merge"]),
  target: z.string().min(1).max(100).optional(),
  fields: z.partialRecord(z.enum(DRAFT_FIELDS), z.string().max(20000).nullable()).optional(),
  bullets: z.array(z.string().max(20000)).max(100).optional(),
})).max(1000).superRefine((decisions, context) => {
  if (new Set(decisions.map((decision) => decision.key)).size !== decisions.length) {
    context.addIssue({ code: "custom", message: "duplicate decision" });
  }
});
export type AdoptDecisions = z.infer<typeof adoptDecisionsSchema>;
type Decision = AdoptDecisions[number];
type DraftField = typeof DRAFT_FIELDS[number];
type Section = typeof DRAFT_SECTIONS[number];
const sameContent = (left: string, right: string) => normalizeCareerContent(left) === normalizeCareerContent(right);
const fieldValue = (entry: DraftEntry, key: DraftField) => entry.fields[key]?.value ?? "";

function adoptionText(draft: CareerDraft) {
  const text = (value: string): Text => ({
    id: "",
    primary: "",
    wordings: [{
      id: "", text: value, lang: draft.language, label: null, origin: "extracted",
      from_document: null, from_story: null, created_at: draft.created_at,
    }],
  });
  const wording = (current: Text | null, value: string): Text | null => {
    if (!value.trim()) return current;
    if (!current) return text(value);
    if (!current.wordings.some((item) => sameContent(item.text, value))) {
      current.wordings.push(text(value).wordings[0]!);
    }
    return current;
  };
  const bullets = (current: Text[], values: string[]) => {
    for (const value of values) {
      const exists = current.some((item) => item.wordings.some((wording) => sameContent(wording.text, value)));
      if (value.trim() && !exists) current.push(text(value));
    }
    return current;
  };
  return { text, wording, bullets };
}
type AdoptionText = ReturnType<typeof adoptionText>;

function applyFieldEdits(entry: DraftEntry, decision?: Decision): void {
  for (const [key, value] of Object.entries(decision?.fields ?? {})) {
    entry.fields[key as DraftField] = value == null ? null : { value, quote: "", flags: [] };
  }
}

function reviewedEntry(original: DraftEntry, decisions: Map<string, Decision>): DraftEntry {
  const entry = structuredClone(original);
  entry.items = entry.items.flatMap((item) => {
    const decision = decisions.get(item.key);
    decisions.delete(item.key);
    if (decision?.action === "skip") return [];
    applyFieldEdits(item, decision);
    if (decision?.bullets) item.bullets = decision.bullets.map((value) => ({ value, quote: "", flags: [] }));
    return [item];
  });
  return entry;
}

function adoptCustomItems(custom: CustomSection, entry: DraftEntry, helpers: AdoptionText): void {
  const { text, wording, bullets } = helpers;
  const hasText = (value: string) => custom.items.some((candidate) => candidate.kind !== "entry"
    && sameContent(primaryText(candidate.text), value));
  for (const item of entry.items) {
    const value = (key: DraftField) => fieldValue(item, key);
    const heading = value(item.kind === "text" ? "text" : "heading");
    if (item.kind === "text") {
      if (!hasText(heading)) custom.items.push({ id: "", kind: "text", text: text(heading) });
      for (const bullet of item.bullets) {
        if (!hasText(bullet.value)) custom.items.push({ id: "", kind: "bullet", text: text(bullet.value) });
      }
      continue;
    }
    const existing = custom.items.find((candidate) => {
      if (candidate.kind !== "entry") return sameContent(primaryText(candidate.text), heading);
      return sameContent(primaryText(candidate.heading), heading) && candidate.date === (value("date") || null);
    });
    if (existing?.kind === "entry") {
      wording(existing.heading, heading);
      existing.sub = wording(existing.sub, value("sub"));
      existing.text = wording(existing.text, value("text"));
      bullets(existing.bullets, item.bullets.map((field) => field.value));
      continue;
    }
    if (existing) continue;
    custom.items.push({
      id: "", kind: "entry", heading: text(heading), sub: value("sub") ? text(value("sub")) : null,
      url: null, date: value("date") || null, start: null, end: null, location: null, tags: [],
      text: value("text") ? text(value("text")) : null,
      bullets: bullets([], item.bullets.map((field) => field.value)),
    });
  }
}

function adoptSection(
  result: CareerProfile, section: Section, entry: DraftEntry, decision: Decision, helpers: AdoptionText,
): void {
  const { text, wording, bullets } = helpers;
  const value = (key: DraftField) => fieldValue(entry, key);
  const nullable = (key: DraftField) => value(key) || null;
  const selectedBullets = decision.bullets ?? entry.bullets.map((field) => field.value);
  const stack = entry.stack.map((field) => field.value);
  const explicit = decision.action === "merge" ? decision.target ?? entry.match : null;
  const target = explicit ? result[section].findIndex((item) => item.id === explicit) : -1;
  if (decision.action === "merge" && target < 0) throw new CareerStoreError("unknown_id");
  if (section === "experience") {
    const old = result.experience[target];
    if (old) {
      wording(old.role, value("role"));
      old.summary = wording(old.summary, value("summary"));
      bullets(old.bullets, selectedBullets);
    } else result.experience.push({
      id: "", company: value("company"), role: text(value("role")), url: null, location: nullable("location"),
      start: nullable("start"), end: nullable("end"), summary: value("summary") ? text(value("summary")) : null,
      bullets: bullets([], selectedBullets), stack,
    });
  } else if (section === "projects") {
    const old = result.projects[target];
    if (old) {
      old.tagline = wording(old.tagline, value("tagline"));
      bullets(old.bullets, selectedBullets);
    } else result.projects.push({
      id: "", name: value("name"), url: null, tagline: value("tagline") ? text(value("tagline")) : null,
      bullets: bullets([], selectedBullets), stack,
    });
  } else if (section === "education") {
    const old = result.education[target];
    if (old) {
      wording(old.degree, value("degree"));
      old.summary = wording(old.summary, value("summary"));
      bullets(old.bullets, selectedBullets);
    } else result.education.push({
      id: "", school: value("school"), degree: text(value("degree")), url: null, location: nullable("location"),
      start: nullable("start"), end: nullable("end"), summary: value("summary") ? text(value("summary")) : null,
      bullets: bullets([], selectedBullets),
    });
  } else if (section === "certifications") {
    if (target < 0) result.certifications.push({ id: "", name: value("name"), issuer: nullable("issuer"), date: nullable("date") });
  } else if (section === "languages") {
    if (target < 0) result.languages.push({ id: "", name: value("name"), level: value("level"), code: null, cefr: null });
  } else if (section === "skills") {
    let group = result.skills[target];
    if (!group) {
      group = { id: "", group: value("group"), items: [] };
      result.skills.push(group);
    }
    for (const item of entry.items) {
      const name = item.fields.name?.value ?? "";
      if (name && !group.items.some((item) => sameContent(item.name, name))) group.items.push({ id: "", name, years: null });
    }
  } else {
    let custom = result.custom_sections[target];
    if (!custom) {
      custom = { id: "", title: text(value("title")), layout: "list", side: "main", items: [] };
      result.custom_sections.push(custom);
    }
    adoptCustomItems(custom, entry, helpers);
  }
}

/** Adoption records request/entry keys in the profile; an explicit new entry never resolves through content matching. */
export function adoptDraft(profile: CareerProfile, draft: CareerDraft, decisions: AdoptDecisions): CareerProfile {
  const result = structuredClone(profile);
  const choose = new Map(adoptDecisionsSchema.parse(decisions).map((decision) => [decision.key, decision]));
  const helpers = adoptionText(draft);
  for (const key of ["headline", "summary"] as const) {
    const decision = choose.get(key);
    choose.delete(key);
    if (!decision || decision.action === "skip") continue;
    const adoptionKey = `${draft.request_id}:${key}`;
    if (result.adopted_entries.includes(adoptionKey)) continue;
    const value = decision.fields?.text ?? draft.sections[key]?.value;
    if (value) result[key] = helpers.wording(result[key], value);
    result.adopted_entries.push(adoptionKey);
  }
  for (const section of DRAFT_SECTIONS) for (const original of draft.sections[section]) {
    const decision = choose.get(original.key);
    if (!decision) continue;
    choose.delete(original.key);
    const entry = reviewedEntry(original, choose);
    if (decision.action === "skip") continue;
    const adoptionKey = `${draft.request_id}:${entry.key}`;
    if (result.adopted_entries.includes(adoptionKey)) continue;
    applyFieldEdits(entry, decision);
    adoptSection(result, section, entry, decision, helpers);
    result.adopted_entries.push(adoptionKey);
  }
  if (choose.size) throw new CareerStoreError("draft_invalid");
  return careerProfileSchema.parse(result);
}
