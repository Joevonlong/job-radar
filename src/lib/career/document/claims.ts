import type { CareerConfig } from "@/lib/config/schemas/career";
import { figures } from "@/lib/writer/verify";
import { toOutbound } from "../ai/outbound";
import { factPool } from "../ai/view";
import { CareerStoreError } from "../contact/errors";
import type { CareerDocument, Claim } from "../schema/document";
import type { CareerProfile } from "../schema/profile";
import { normalized, verifyProposal } from "../tailor/verify";
import { documentObjects, documentTexts } from "./targets";

function stillPresent(claim: Claim, value: string, settings: CareerConfig): boolean {
  if (claim.kind === "figure") {
    const actual = figures(value, settings.evidence.figure_units).keys;
    return [...figures(claim.text, settings.evidence.figure_units).keys].every((key) => actual.has(key));
  }
  return claim.text.split(/,\s*/).every((text) => normalized(value).includes(normalized(text)));
}

export function survivingClaims(doc: CareerDocument, settings: CareerConfig): Claim[] {
  const objects = documentObjects(doc);
  return doc.claims.filter((claim) => {
    const target = claim.target;
    const object = "text" in target ? objects.get(target.text) : "entry" in target ? objects.get(target.entry) : null;
    const value = "text" in target ? String(object?.text ?? "") : "entry" in target ? JSON.stringify(object?.[target.field === "skills" ? "items" : target.field] ?? "") : String(doc.letter?.[target.letter] ?? "");
    return stillPresent(claim, value, settings);
  });
}

export function rerunClaims(before: CareerDocument, after: CareerDocument, profile: CareerProfile, settings: CareerConfig): CareerDocument {
  const result = structuredClone(after);
  const objects = documentObjects(result);
  const old = documentObjects(before);
  result.claims = survivingClaims(result, settings);
  const pool = factPool(profile, toOutbound);
  for (const { value } of documentTexts(result)) {
    if (old.get(value.id)?.text === value.text) continue;
    value.origin = "user";
    const checked = verifyProposal({ action: "rewrite", target: { text: value.id }, text: toOutbound(value.text), rationale: "", support: [] }, {
      doc: result, profile, pool, settings, jd: null, sentIds: [...objects.keys(), "headline", "summary", "letter"], allowed: ["rewrite"],
    });
    for (const claim of checked?.claims ?? []) {
      if (claim.kind === "duty") continue;
      if (result.claims.some((existing) => "text" in existing.target && existing.target.text === value.id && existing.kind === claim.kind && normalized(existing.text) === normalized(claim.text))) continue;
      result.claims.push({ ...claim, by: "user", status: "noted" });
    }
  }
  for (const field of ["subject", "salutation", "closing", "place"] as const) {
    const value = result.letter?.[field];
    if (!value || value === before.letter?.[field]) continue;
    const checked = verifyProposal({ action: "rewrite", target: { letter: field }, text: toOutbound(value), support: [], rationale: "" }, {
      doc: result, profile, pool, settings, jd: null, sentIds: [...objects.keys(), "summary", "headline", "letter"], allowed: ["rewrite"],
    });
    for (const claim of checked?.claims ?? []) {
      if (claim.kind === "duty" || result.claims.some((previous) => "letter" in previous.target && previous.target.letter === field && previous.kind === claim.kind && normalized(previous.text) === normalized(claim.text))) continue;
      result.claims.push({ ...claim, by: "user", status: "noted" });
    }
  }
  for (const [id, object] of objects) {
    if (!id.startsWith("ent_")) continue;
    const previous = old.get(id);
    const fields = Array.isArray(object.stack) ? ["stack"] : Array.isArray(object.items) && "group" in object ? ["skills"] : [];
    for (const field of fields) {
      const current = field === "stack" ? object.stack as string[] : (object.items as { name: string }[]).map((item) => item.name);
      const earlier = field === "stack" ? previous?.stack as string[] | undefined : (previous?.items as { name: string }[] | undefined)?.map((item) => item.name);
      for (const value of current.filter((value) => !earlier?.includes(value))) {
        const checked = verifyProposal({ action: "add", target: { entry: id, field: field as "stack" | "skills" }, text: toOutbound(value), support: [], rationale: "" }, {
          doc: result, profile, pool, settings, jd: null, sentIds: [...objects.keys(), "headline", "summary", "letter"], allowed: ["add"],
        });
        result.claims.push(...(checked?.claims ?? []).map((claim) => ({ ...claim, by: "user" as const, status: "noted" as const })));
      }
    }
  }
  return result;
}

export function confirmTranslation(doc: CareerDocument): CareerDocument {
  return { ...doc, claims: doc.claims.map((claim) => claim.translation && claim.status === "pending" ? { ...claim, status: "confirmed" } : claim) };
}
export function decideClaim(doc: CareerDocument, id: string, status: "confirmed" | "rejected"): CareerDocument {
  if (!doc.claims.some((claim) => claim.id === id)) throw new CareerStoreError("target_gone");
  return { ...doc, claims: doc.claims.map((claim) => claim.id === id ? { ...claim, status } : claim) };
}
