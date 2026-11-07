import type { CareerConfig } from "@/lib/config/schemas/career";
import { newId } from "../schema/ids";
import { parseStoredDocument, type CareerDocument, type DocText } from "../schema/document";
import type { CareerProfile, Text } from "../schema/profile";

export function generateDocument(
  profile: CareerProfile,
  profileHash: string | null,
  layoutDefaults: CareerConfig["document"]["defaults"],
  now: string,
  title: string,
): CareerDocument {
  function text(value: Text): DocText {
    const wording = value.wordings.find((item) => item.lang === layoutDefaults.lang)
      ?? value.wordings.find((item) => item.id === value.primary) ?? value.wordings[0]!;
    return { id: newId("dtx"), source: { text_id: value.id, wording_id: wording.id }, text: wording.text, origin: "source" };
  }
  const optional = (value: Text | null) => value === null ? null : text(value);
  const entry = (value: { id: string }) => ({ id: newId("ent"), source: { entry_id: value.id }, included: true });
  return parseStoredDocument({
    schema_version: 1, id: newId("doc"), title, kind: "general", job: null, profile_hash: profileHash,
    created_at: now, updated_at: now,
    layout: { ...layoutDefaults, colors: "quiet", filename: null, sections: null, signature: null },
    hide_contact: [], requirements: [], headline: optional(profile.headline), summary: optional(profile.summary),
    experience: profile.experience.map((value) => ({
      ...value, ...entry(value), role: text(value.role), summary: optional(value.summary), bullets: value.bullets.map(text),
    })),
    projects: profile.projects.map((value) => ({
      ...value, ...entry(value), tagline: optional(value.tagline), bullets: value.bullets.map(text),
    })),
    education: profile.education.map((value) => ({
      ...value, ...entry(value), degree: text(value.degree), summary: optional(value.summary), bullets: value.bullets.map(text),
    })),
    certifications: profile.certifications.map((value) => ({ ...value, ...entry(value) })),
    languages: profile.languages.map((value) => ({ ...entry(value), name: value.name, level: value.level })),
    skills: profile.skills.map((value) => ({
      ...entry(value), group: value.group,
      items: value.items.map((item) => ({ id: newId("itm"), source: { item_id: item.id }, name: item.name, included: true })),
    })),
    approach: profile.approach.map((value) => ({ ...value, ...entry(value), text: text(value.text) })),
    custom_sections: profile.custom_sections.map((value) => ({
      ...value, ...entry(value), title: text(value.title), columns: null,
      items: value.items.map((item) => item.kind === "entry" ? {
        ...item, ...entry(item), heading: text(item.heading), sub: optional(item.sub),
        text: optional(item.text), bullets: item.bullets.map(text),
      } : { ...item, ...entry(item), text: text(item.text) }),
    })),
    letter: null, claims: [],
  });
}
