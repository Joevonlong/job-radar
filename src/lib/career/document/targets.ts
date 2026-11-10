import type { CareerDocument, DocText } from "../schema/document";

export interface TextTarget { value: DocText; entry: string | null; letter: boolean }

export function documentTexts(doc: CareerDocument): TextTarget[] {
  const result: TextTarget[] = [];
  function walk(value: unknown, entry: string | null, letter: boolean): void {
    if (Array.isArray(value)) { value.forEach((item) => walk(item, entry, letter)); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string" && object.id.startsWith("ent_")) entry = object.id;
    if (typeof object.id === "string" && object.id.startsWith("dtx_") && typeof object.text === "string") {
      result.push({ value: object as DocText, entry, letter });
      return;
    }
    for (const [key, child] of Object.entries(object)) {
      if (!["claims", "source"].includes(key)) walk(child, entry, letter || key === "letter");
    }
  }
  walk(doc, null, false);
  return result;
}

export function documentObjects(doc: CareerDocument): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  function walk(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (typeof object.id === "string") result.set(object.id, object);
    for (const [key, child] of Object.entries(object)) if (!["claims", "source"].includes(key)) walk(child);
  }
  walk(doc);
  return result;
}
