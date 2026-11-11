import { z } from "zod";
import { emptyContact } from "@/lib/career/schema/contact";

export const contactSentinels = {
  ...emptyContact(),
  name: "Fictional Sentinel Person",
  email: "secret@example.test",
  phone: "+49 555 87654321",
  address: "42 Fictional Avenue",
  work_auth: "Fictional work authorization",
  availability: "Fictional availability",
  location: "Exampletown",
  links: [{ label: "Fictional portfolio", url: "https://private.example.test/profile" }],
};
export const sentinels = [
  contactSentinels.name, contactSentinels.email, contactSentinels.phone, contactSentinels.address,
  contactSentinels.work_auth, contactSentinels.availability, contactSentinels.links[0]!.label,
  contactSentinels.links[0]!.url,
];
export const sentinelText = sentinels.slice(0, 4).join("; ");

/** Populate every nullable and optional branch, including each array union variant, from the actual schema. */
export function allFieldsExample(schema: z.ZodType, sentinel = sentinelText): unknown {
  const root = z.toJSONSchema(schema) as Record<string, unknown>;
  let sequence = 0;
  function build(raw: unknown, key = ""): unknown {
    const node = raw as Record<string, unknown>;
    if (typeof node.$ref === "string") {
      let value: unknown = root;
      for (const part of node.$ref.slice(2).split("/")) value = (value as Record<string, unknown>)[part];
      return build(value, key);
    }
    if (Array.isArray(node.anyOf)) return build(node.anyOf.find((n) => (n as Record<string, unknown>).type !== "null"), key);
    if (node.const !== undefined) return node.const;
    if (Array.isArray(node.enum)) return node.enum[0];
    if (node.type === "object") {
      const value = Object.fromEntries(Object.entries(node.properties as object).map(([field, child]) => [field, build(child, field)]));
      if ("primary" in value) value.primary = (value.wordings as { id: string }[])[0]!.id;
      return value;
    }
    if (node.type === "array") {
      if (key === "adopted_entries") return [];
      const items = node.items as Record<string, unknown>;
      const variants = items.anyOf ?? items.oneOf;
      return Array.isArray(variants) ? variants.map((variant) => build(variant, key)) : [build(items, key)];
    }
    if (node.type === "boolean") return true;
    if (node.type === "number" || node.type === "integer") return Math.max(1, Number(node.minimum ?? 1));
    if (node.type === "null") return null;
    if (node.type === "string") {
      if (node.format === "date-time") return "2026-01-01T00:00:00Z";
      if (node.format === "date") return "2026-01-01";
      if (node.format === "uri") return contactSentinels.links[0]!.url;
      if (key === "jd_hash" || key === "profile_hash") return "a".repeat(64);
      if (["start", "end", "date"].includes(key)) return "2020";
      if (key === "accent") return "#123456";
      if (key === "code") return "en";
      if (typeof node.pattern === "string") {
        const prefix = node.pattern.match(/doc|ent|dtx|clm|exp|prj|edu|crt|lng|skg|skl|apr|sec|itm|txt|wrd/)?.[0];
        if (prefix) {
          let serial = ++sequence;
          let suffix = "";
          while (serial > 0) { suffix += String.fromCharCode(97 + serial % 26); serial = Math.floor(serial / 26); }
          return `${prefix}_${suffix.padEnd(10, "a")}`;
        }
        throw new Error(`Unhandled structural string: ${key} ${node.pattern}`);
      }
      return sentinel;
    }
    throw new Error(`Unhandled schema: ${JSON.stringify(node)}`);
  }
  return build(root);
}
