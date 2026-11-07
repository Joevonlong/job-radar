import { expect, it } from "vitest";
import { careerSchema } from "@/lib/config/schemas/career";
import { changedProtectedPaths, isProtectedPath } from "@/lib/config/protected-keys";
import { HIDDEN_PATHS } from "@/lib/settings/fields";

it("defaults older career overlays and accepts configured PDF limits", () => {
  expect(careerSchema.parse({}).pdf).toEqual({
    url: "http://career-pdf:8090", timeout_seconds: 60, max_html_bytes: 8000000,
  });
  const configured = { pdf: { url: "https://pdf.invalid", timeout_seconds: 9, max_html_bytes: 400 },
    preview: { page_count_debounce_ms: 700 } };
  expect(careerSchema.parse(configured)).toMatchObject(configured);
});

it.each([
  { pdf: { url: "file:///tmp/secret" } }, { pdf: { url: "invalid" } }, { pdf: { extra: true } },
  { pdf: { timeout_seconds: 0 } }, { pdf: { timeout_seconds: 301 } }, { pdf: { max_html_bytes: 0 } },
  { pdf: { max_html_bytes: 50000001 } }, { preview: { page_count_debounce_ms: 0 } },
])("rejects invalid PDF settings %j", (raw) => { expect(careerSchema.safeParse(raw).success).toBe(false); });

it("protects the endpoint and hides the PDF block from the settings form", () => {
  expect(isProtectedPath("career", "pdf.url")).toBe(true);
  expect(isProtectedPath("career", "pdf.timeout_seconds")).toBe(false);
  expect(changedProtectedPaths("career", { pdf: { url: "http://other.invalid" } },
    { pdf: { url: "http://current.invalid" } }, { pdf: { url: "http://default.invalid" } })).toEqual([["pdf", "url"]]);
  expect(HIDDEN_PATHS.career).toContain("pdf");
});
