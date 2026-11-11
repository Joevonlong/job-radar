import type { CareerDocument } from "../schema/document";
import { visitProfile, type CareerProfile, type Text } from "../schema/profile";

export interface SourceStates {
  profileChanged: boolean;
  texts: Record<string, "source_deleted" | "wording_deleted">;
  entries: Record<string, "source_deleted">;
}

export function sourceStates(document: CareerDocument, profile: CareerProfile, profileHash: string | null): SourceStates {
  const texts = new Map<string, Text>();
  const entries = new Set<string>();
  visitProfile(profile, (object) => {
    if (typeof object.id !== "string") return;
    if ("wordings" in object) texts.set(object.id, object as Text);
    else if (!("created_at" in object)) entries.add(object.id);
  });
  const states: SourceStates = { profileChanged: document.profile_hash !== profileHash, texts: {}, entries: {} };
  visitProfile(document, (object) => {
    if (typeof object.id !== "string" || !object.source || typeof object.source !== "object") return;
    const source = object.source as Record<string, unknown>;
    if ("text_id" in source && "wording_id" in source) {
      const text = texts.get(String(source.text_id));
      if (!text) states.texts[object.id] = "source_deleted";
      else if (!text.wordings.some((wording) => wording.id === source.wording_id || wording.text === object.text))
        states.texts[object.id] = "wording_deleted";
    } else {
      if (!entries.has(String(source.entry_id ?? source.item_id))) states.entries[object.id] = "source_deleted";
    }
  });
  return states;
}
