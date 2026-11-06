import { profileContent, type CareerProfile } from "../schema/profile";

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
