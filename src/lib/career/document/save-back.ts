import type { CareerConfig } from "@/lib/config/schemas/career";
import { CareerStoreError } from "../contact/errors";
import type { CareerDocument } from "../schema/document";
import { visitProfile, checkProfileLimits, type CareerProfile, type Text } from "../schema/profile";
import { loadCareerProfile, saveCareerProfile } from "../store/profile";
import { persistDocument } from "../store/documents";
import { reloadConfig } from "@/lib/config/load";
import { normalized } from "../tailor/verify";
import { documentTexts } from "./targets";
import { markOf } from "./marks";

export function saveBack(doc: CareerDocument, profile: CareerProfile, textId: string, target: string | undefined, settings: CareerConfig) {
  const document = structuredClone(doc);
  const next = structuredClone(profile);
  const text = documentTexts(document).find((item) => item.value.id === textId)?.value;
  if (!text) throw new CareerStoreError("target_gone");
  if (markOf(text, document.claims) === "unverified") throw new CareerStoreError("unresolved_claims");
  let source: Text | undefined;
  visitProfile(next, (object) => { if (object.id === text.source?.text_id && "wordings" in object) source = object as Text; });
  const now = new Date().toISOString();
  const wording = { id: "", text: text.text, lang: doc.layout.lang, label: null, origin: "from_document" as const, from_document: doc.id, from_story: null, created_at: now };
  if (!source) {
    let entry: Record<string, unknown> | undefined;
    visitProfile(next, (object) => { if (object.id === target && Array.isArray(object.bullets)) entry = object; });
    if (!entry) throw new CareerStoreError("target_gone");
    source = (entry.bullets as Text[]).find((candidate) => candidate.wordings.some((value) => value.from_document === doc.id && normalized(value.text) === normalized(text.text)));
    if (!source) {
      source = { id: "", primary: "", wordings: [wording] };
      (entry.bullets as Text[]).push(source);
    }
  }
  let existing = source.wordings.find((item) => normalized(item.text) === normalized(text.text));
  if (!existing) { source.wordings.push(wording); existing = wording; }
  checkProfileLimits(next, settings.profile);
  return { profile: next, document, source, wording: existing };
}

/** Profile first; a retry finds the normalized wording if the document write failed after the profile commit. */
export async function saveBackToProfile(docId: string, textId: string, options: { baseHash: string; target?: string }) {
  return persistDocument(docId, options.baseHash, async (doc) => {
    const loaded = await loadCareerProfile();
    const prepared = saveBack(doc, loaded.profile, textId, options.target, reloadConfig("career"));
    const saved = await saveCareerProfile(prepared.profile, { baseHash: loaded.baseHash });
    if (!saved.ok) throw new CareerStoreError("write_failed");
    let source: Text | undefined;
    if (prepared.source.id) {
      visitProfile(saved.profile, (object) => { if (object.id === prepared.source.id && "wordings" in object) source = object as Text; });
    } else {
      visitProfile(saved.profile, (object) => {
        if (object.id !== options.target || !Array.isArray(object.bullets)) return;
        source = (object.bullets as Text[]).find((text) => text.wordings.some((wording) => wording.from_document === docId && normalized(wording.text) === normalized(prepared.wording.text)));
      });
    }
    if (!source) throw new CareerStoreError("write_failed");
    const wording = source.wordings.find((wording) => normalized(wording.text) === normalized(prepared.wording.text))!;
    const text = documentTexts(prepared.document).find((item) => item.value.id === textId)!.value;
    text.source = { text_id: source.id, wording_id: wording.id };
    text.origin = "source";
    prepared.document.claims = prepared.document.claims.filter((claim) => !("text" in claim.target && claim.target.text === textId));
    prepared.document.updated_at = new Date().toISOString();
    return prepared.document;
  });
}
