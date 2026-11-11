import { profileContent, visitProfile, type CareerProfile } from "../schema/profile";

/** AI views keep every wording and content field, excluding local identifiers, source metadata and URLs. */
export function careerAiView(profile: CareerProfile): string {
  const render = (value: unknown): string => {
    if (value === null) return "";
    if (Array.isArray(value)) return value.map((item) => `-\n${render(item)}`).join("\n");
    if (typeof value === "object") return Object.entries(value).filter(([key]) => !["url", "id", "primary", "created_at", "from_document", "from_story"].includes(key)).map(([key, value]) => `${key}:\n${render(value)}`).join("\n");
    return String(value);
  };
  return render(profileContent(profile));
}

/** Content projection for both confirmation and evidence pools; contact, links and provenance never enter it. */
export function documentView(value: unknown): string {
  return JSON.stringify(contentView(value));
}

export function contentView(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentView);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ![
    "url", "source", "origin", "claims", "created_at", "updated_at", "profile_hash", "hide_contact", "layout", "job", "requirements",
    "primary", "from_document", "from_story", "adopted_entries", "schema_version",
  ].includes(key)).map(([key, child]) => [key, contentView(child)]));
}

export interface FactPool { all: string; entries: Record<string, string> }
export function factPool(profile: CareerProfile, project: (text: string) => string): FactPool {
  const entries: Record<string, string> = {};
  visitProfile(profile, (object) => {
    if (typeof object.id === "string" && !object.id.startsWith("wrd_")) entries[object.id] = project(factualView(object));
  });
  return { all: project(factualView(profileContent(profile))), entries };
}

function factualView(value: unknown): string {
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !["id", "lang", "label"].includes(key)).map(([key, child]) => [key, clean(child)]));
  };
  return JSON.stringify(clean(contentView(value)));
}
