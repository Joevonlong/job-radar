import { loadConfig } from "@/lib/config";
import { readUserFile } from "@/lib/config/read-user-file";
import { parseConfigYaml } from "@/lib/config/yaml-options";
import { prepareScrub, scrubFinal, scrubOutbound, type ScrubKind, type ScrubRules, type StoredValues } from "@/lib/outbound/scrub";
import { confirmedOutbound, toOutbound } from "@/lib/outbound/outbound";
import { careerContactSchema, emptyContact, type CareerContact } from "../schema/contact";
import { careerContactPath } from "../store/paths";
import { CareerStoreError } from "./errors";

function contactForScrub(): CareerContact {
  let source: string;
  try { source = readUserFile(careerContactPath()).toString("utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyContact();
    throw new CareerStoreError("contact_unreadable");
  }
  try { return careerContactSchema.parse(parseConfigYaml(source)); }
  catch { throw new CareerStoreError("contact_invalid"); }
}

function storedValues(): StoredValues {
  const contact = contactForScrub();
  const min = loadConfig("career").import.stored_value_min_chars;
  const values: { value: string; kind: ScrubKind; highlightOnly?: boolean }[] = [];
  for (const kind of ["name", "address", "email", "phone", "work_auth", "availability"] as const) {
    const value = contact[kind];
    if (value?.trim()) values.push({ value, kind, highlightOnly: (kind === "work_auth" || kind === "availability") && value.trim().length < min });
  }
  if (contact.name?.trim()) values.push({ value: contact.name.trim().split(/\s+/).reverse().join(" "), kind: "name" });
  for (const link of contact.links) values.push({ value: link.url, kind: "link" });
  return { values, location: contact.location };
}

export function scrubCareerFinal(text: string) { return scrubFinal(text, storedValues()); }
export function scrubCareerOutbound(text: string) { return scrubOutbound(text, storedValues()); }
export function outboundCareerText(text: string) { return toOutbound(text, storedValues()); }
export function confirmCareerText(text: string) { return confirmedOutbound(text, storedValues()); }

/** Only preview routes may return the local candidate values to the browser. */
export function prepareCareerScrub(text: string, input: { rules: ScrubRules; name?: string; address?: string; mode?: "values" }) {
  return prepareScrub(text, { ...input, stored: storedValues() });
}
