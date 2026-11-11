/** All free strings are scrubbed; only schema-constrained identifiers, dates and layout values pass through. */
const structural = new Set([
  "id", "primary", "entry_id", "text_id", "wording_id", "item_id",
  "kind", "origin", "created_at", "updated_at", "date", "start", "end",
  "profile_hash", "jd_hash", "schema_version", "status", "by", "side", "code", "cefr",
]);
const layout = new Set(["lang", "theme", "accent", "paper", "density", "colors", "custom"]);

export function redactStructure(value: unknown, scrub: (text: string) => string, path: string[] = []): unknown {
  if (typeof value === "string") {
    const key = path.at(-1) ?? "";
    const fixed = structural.has(key) || key === "layout" || key === "hide_contact" ||
      (path[0] === "layout" && (layout.has(key) || key === "sections")) ||
      (path.includes("target") && ["text", "entry", "letter"].includes(key));
    return fixed ? value : scrub(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactStructure(item, scrub, path));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStructure(item, scrub, [...path, key])]));
  }
  return value;
}
