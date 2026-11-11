import { randomBytes } from "node:crypto";

import { CareerStoreError } from "../contact/errors";
import { careerProfileSchema, visitProfile, type CareerProfile, type Text } from "./profile";

export const ID_PREFIXES = [
  "exp",
  "prj",
  "edu",
  "crt",
  "lng",
  "skg",
  "skl",
  "apr",
  "sec",
  "itm",
  "txt",
  "wrd",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];
export const DOCUMENT_ID_PREFIXES = ["doc", "ent", "dtx", "itm"] as const;
export type DocumentIdPrefix = (typeof DOCUMENT_ID_PREFIXES)[number];

export function newId(prefix: IdPrefix | DocumentIdPrefix | "clm" | "prp"): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `${prefix}_${Array.from(randomBytes(10), (byte) => alphabet[byte & 31]).join("")}`;
}

/** Only ids already present in the stored profile can come from the browser. Empty ids are assigned on the server. */
export function assignIds(profile: CareerProfile, previous: CareerProfile): CareerProfile {
  const known = new Set<string>();
  visitProfile(previous, (object) => {
    if (typeof object.id === "string") known.add(object.id);
  });
  const result = structuredClone(profile);

  function assign(object: { id: string }, prefix: IdPrefix): void {
    if (object.id !== "") {
      if (!known.has(object.id)) throw new CareerStoreError("unknown_id");
      return;
    }
    let fresh = newId(prefix);
    while (known.has(fresh)) fresh = newId(prefix);
    known.add(fresh);
    object.id = fresh;
  }

  function assignText(text: Text | null): void {
    if (!text) return;
    assign(text, "txt");
    for (const wording of text.wordings) assign(wording, "wrd");
    if (text.primary === "") text.primary = text.wordings[0]!.id;
  }

  assignText(result.headline);
  assignText(result.summary);
  for (const entry of result.experience) {
    assign(entry, "exp");
    assignText(entry.role);
    assignText(entry.summary);
    entry.bullets.forEach(assignText);
  }
  for (const entry of result.projects) {
    assign(entry, "prj");
    assignText(entry.tagline);
    entry.bullets.forEach(assignText);
  }
  for (const entry of result.education) {
    assign(entry, "edu");
    assignText(entry.degree);
    assignText(entry.summary);
    entry.bullets.forEach(assignText);
  }
  for (const entry of result.certifications) assign(entry, "crt");
  for (const entry of result.languages) assign(entry, "lng");
  for (const group of result.skills) {
    assign(group, "skg");
    for (const item of group.items) assign(item, "skl");
  }
  for (const entry of result.approach) {
    assign(entry, "apr");
    assignText(entry.text);
  }
  for (const section of result.custom_sections) {
    assign(section, "sec");
    assignText(section.title);
    for (const item of section.items) {
      assign(item, "itm");
      assignText(item.text);
      if (item.kind === "entry") {
        assignText(item.heading);
        assignText(item.sub);
        item.bullets.forEach(assignText);
      }
    }
  }
  return careerProfileSchema.parse(result);
}
