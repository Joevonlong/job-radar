import { CareerStoreError } from "../contact/errors";
import { documentSchema, parseStoredDocument, type CareerDocument } from "../schema/document";
import { newId, type DocumentIdPrefix } from "../schema/ids";
import { visitProfile } from "../schema/profile";

/** Identity and provenance belong to the server, even when edits arrive as raw YAML. */
export function applyDocumentEdit(stored: CareerDocument, incoming: unknown, now: string): CareerDocument {
  return editDocument(stored, incoming, now, [stored]);
}

/** Only a validated version read from this document's history may reintroduce removed ids. */
export function applyDocumentRestore(stored: CareerDocument, version: CareerDocument, now: string): CareerDocument {
  return editDocument(stored, version, now, [version, stored]);
}

function editDocument(stored: CareerDocument, incoming: unknown, now: string, known: CareerDocument[]): CareerDocument {
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) throw new CareerStoreError("document_invalid");
  const parsed = documentSchema.safeParse({
    ...incoming, id: stored.id, kind: stored.kind, job: stored.job, profile_hash: stored.profile_hash,
    created_at: stored.created_at, claims: stored.claims, updated_at: now,
  });
  if (!parsed.success) throw new CareerStoreError("document_invalid");
  const previous = new Map<string, Record<string, unknown>>();
  known.forEach((document) => visitProfile(document, (object) => {
    if (typeof object.id === "string") previous.set(object.id, object);
  }));
  const used = new Set(previous.keys());
  const skillItems = new Set<object>(parsed.data.skills.flatMap((group) => group.items));
  visitProfile(parsed.data, (object) => {
    if (typeof object.id !== "string") return;
    if (object.id !== "") {
      const old = previous.get(object.id);
      if (!old) throw new CareerStoreError("unknown_id");
      if ("source" in object) object.source = structuredClone(old.source);
      if ("origin" in object) object.origin = object.text === old.text ? old.origin : "user";
      return;
    }
    const prefix: DocumentIdPrefix = "origin" in object ? "dtx" : skillItems.has(object) ? "itm" : "ent";
    let fresh = newId(prefix);
    while (used.has(fresh)) fresh = newId(prefix);
    used.add(fresh);
    object.id = fresh;
    if ("source" in object) object.source = null;
    if ("origin" in object) object.origin = "user";
  });
  return parseStoredDocument(parsed.data);
}


export function prepareDocumentCreation(raw: unknown): CareerDocument {
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) throw new CareerStoreError("document_invalid");
  const used = new Set<string>();
  visitProfile(parsed.data, (object) => {
    if (typeof object.id === "string" && object.id) used.add(object.id);
  });
  const skillItems = new Set<object>(parsed.data.skills.flatMap((group) => group.items));
  visitProfile(parsed.data, (object) => {
    if (object.id !== "") return;
    const prefix: DocumentIdPrefix = object === parsed.data ? "doc" : "origin" in object ? "dtx" : skillItems.has(object) ? "itm" : "ent";
    let fresh = newId(prefix);
    while (used.has(fresh)) fresh = newId(prefix);
    used.add(fresh);
    object.id = fresh;
    if ("source" in object) object.source = null;
    if ("origin" in object) object.origin = "user";
  });
  return parseStoredDocument(parsed.data);
}
