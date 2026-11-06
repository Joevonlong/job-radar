import type { CareerConfig } from "@/lib/config/schemas/career";
import { loadConfig } from "@/lib/config";
import { survivingClaims } from "../document/claims";
import { CareerStoreError } from "../contact/errors";
import { documentObjects } from "../document/targets";
import { parseStoredDocument, type CareerDocument, type DocText } from "../schema/document";
import { loadDocument, persistDocument } from "../store/documents";
import { readProposals, removeProposal } from "./proposals";
import type { Proposal } from "./proposal-schema";
import { derivedId, proposalList } from "./verify";

function emptyLetter(): NonNullable<CareerDocument["letter"]> {
  return { recipient: [], place: null, date: null, subject: null, salutation: null, body: [], closing: null };
}

export function applyProposal(doc: CareerDocument, item: Proposal, settings: CareerConfig): { document: CareerDocument; state: "applied" | "target_gone" } {
  const result = structuredClone(doc);
  const target = item.target;
  const objects = documentObjects(result);
  const object = "text" in target ? objects.get(target.text) : "entry" in target ? objects.get(target.entry) : undefined;
  if (("text" in target || "entry" in target) && !object) return { document: doc, state: "target_gone" };
  if ("letter" in target || "list" in target && target.list === "letter.body") result.letter ??= emptyLetter();
  const list = "list" in target ? proposalList(result, target.list) : null;
  if ("list" in target && !list) return { document: doc, state: "target_gone" };
  if (item.action === "drop" || item.action === "include") {
    if (!object) return { document: doc, state: "target_gone" };
    object.included = item.action === "include";
  } else if (item.action === "rewrite" || item.action === "shorten") {
    if ("letter" in target && result.letter) {
      if (target.letter === "recipient") result.letter.recipient = (item.text ?? "").split("\n");
      else if (target.letter === "date") return { document: doc, state: "target_gone" };
      else result.letter[target.letter] = item.text ?? "";
    } else if (object && "origin" in object) {
      object.text = item.text ?? "";
      object.origin = "ai";
    } else return { document: doc, state: "target_gone" };
  } else if (item.action === "add") {
    if ("entry" in target && object && target.field) {
      if (target.field === "stack" && Array.isArray(object.stack)) {
        if (!object.stack.includes(item.text)) object.stack.push(item.text);
      } else if (target.field === "skills" && Array.isArray(object.items)) {
        const id = derivedId("itm", item.id);
        if (!objects.has(id)) object.items.push({ id, source: null, name: item.text, included: true });
      } else return { document: doc, state: "target_gone" };
    } else if (list && "list" in target) {
      const id = derivedId(target.list.endsWith(".items") ? "itm" : "dtx", item.id);
      if (target.list.endsWith(".stack")) {
        if (!list.includes(item.text)) list.push(item.text);
      } else if (!objects.has(id)) {
        if (!(target.list.endsWith(".bullets") || target.list === "letter.body" || target.list.endsWith(".items"))) return { document: doc, state: "target_gone" };
        const value: DocText | { id: string; source: null; name: string; included: boolean } = target.list.endsWith(".items")
          ? { id, source: null, name: item.text ?? "", included: true }
          : { id, source: null, text: item.text ?? "", origin: "ai" };
        const index = item.after ? list.findIndex((value) => value && typeof value === "object" && "id" in value && value.id === item.after) : list.length - 1;
        list.splice(index < 0 ? list.length : index + 1, 0, value);
      }
    } else return { document: doc, state: "target_gone" };
  } else if (item.action === "reorder" && list) {
    const byId = new Map(list.flatMap((value) => value && typeof value === "object" && "id" in value ? [[String(value.id), value] as const] : []));
    if (item.order?.length !== list.length || item.order.some((id) => !byId.has(id)) || new Set(item.order).size !== list.length) return { document: doc, state: "target_gone" };
    list.splice(0, list.length, ...item.order.map((id) => byId.get(id)));
  }
  result.claims = survivingClaims(result, settings);
  for (const claim of item.claims) if (!result.claims.some((existing) => existing.id === claim.id)) result.claims.push(claim);
  return { document: parseStoredDocument(result), state: "applied" };
}

export async function acceptProposal(docId: string, itemId: string, baseHash: string) {
  if (!(await readProposals(docId))?.items.some((item) => item.id === itemId)) {
    return { ok: true as const, ...await loadDocument(docId), warnings: [], state: "missing" as const };
  }
  let state: "applied" | "target_gone" | "missing" = "missing";
  const saved = await persistDocument(docId, baseHash, async (doc) => {
    const proposals = await readProposals(docId);
    const item = proposals?.items.find((item) => item.id === itemId);
    if (!item) return doc;
    const applied = applyProposal(doc, item, loadConfig("career"));
    state = applied.state;
    return { ...applied.document, updated_at: new Date().toISOString() };
  }, async () => { if (state === "applied") await removeProposal(docId, itemId); });
  return { ...saved, state };
}

export async function rejectProposal(docId: string, itemId: string): Promise<void> {
  if (!(await readProposals(docId))?.items.some((item) => item.id === itemId)) throw new CareerStoreError("target_gone");
  await removeProposal(docId, itemId);
}
