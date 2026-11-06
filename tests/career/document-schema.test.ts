import { describe, expect, it } from "vitest";
import { documentSchema, parseStoredDocument } from "@/lib/career/schema/document";
import { CAREER_FILE_BOUNDS } from "@/lib/career/schema/profile";
import { document } from "./document-fixtures";

describe("document format", () => {
  it("round trips all sections with server ids", () => {
    const value = document();
    expect(parseStoredDocument(value)).toEqual(value);
    value.experience[0]!.id = "";
    expect(documentSchema.safeParse(value).success).toBe(true);
    expect(() => parseStoredDocument(value)).toThrow("document_invalid");
  });
  it.each(["email", "phone", "name", "unknown"])("rejects a top-level %s field", (key) => {
    expect(documentSchema.safeParse({ ...document(), [key]: "private" }).success).toBe(false);
  });
  it("uses strict nested objects and accepts only the supported languages", () => {
    const value = document();
    expect(documentSchema.safeParse({ ...value, layout: { ...value.layout, lang: "zh" } }).success).toBe(false);
    expect(documentSchema.safeParse({ ...value, layout: { ...value.layout, lang: "de", email: "private" } }).success).toBe(false);
    expect(documentSchema.safeParse({ ...value, layout: { ...value.layout, lang: "de" } }).success).toBe(true);
    expect(documentSchema.safeParse({ ...value, claims: [{}] }).success).toBe(false);
    const missing = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "claims"));
    expect(documentSchema.safeParse(missing).success).toBe(false);
  });
  it("rejects duplicate definitions but allows repeated source references and blank input ids", () => {
    const value = document();
    value.summary = { ...value.headline!, id: "" };
    expect(documentSchema.safeParse(value).success).toBe(true);
    value.summary.id = value.headline!.id;
    expect(documentSchema.safeParse(value).success).toBe(false);
    value.summary.id = value.experience[0]!.id;
    expect(documentSchema.safeParse(value).success).toBe(false);
  });
  it("enforces string, array, aggregate entry, signature and accent bounds", () => {
    const value = document();
    for (const patch of [
      { title: "x".repeat(CAREER_FILE_BOUNDS.textChars + 1) },
      { requirements: Array<string>(CAREER_FILE_BOUNDS.listItems + 1).fill("x") },
      { hide_contact: ["email", "email"] },
      { layout: { ...value.layout, accent: "red;display:none" } },
      { layout: { ...value.layout, accent: "x".repeat(65) } },
      { layout: { ...value.layout, pages: 11 } },
      { layout: { ...value.layout, signature: { place: null, date: "2026-02-30" } } },
      { layout: { ...value.layout, filename: "x".repeat(201) } },
    ]) expect(documentSchema.safeParse({ ...value, ...patch }).success, JSON.stringify(patch).slice(0, 80)).toBe(false);
    const entry = { ...value.certifications[0]!, id: "" };
    value.certifications = Array.from({ length: CAREER_FILE_BOUNDS.entries }, () => ({ ...entry }));
    expect(documentSchema.safeParse(value).success).toBe(false);
    value.experience[0]!.bullets = Array.from({ length: CAREER_FILE_BOUNDS.bullets + 1 }, () => ({ ...value.headline!, id: "" }));
    expect(documentSchema.safeParse(value).success).toBe(false);
  });
});
