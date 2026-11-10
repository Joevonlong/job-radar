// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/career/contact/store", () => ({ loadContact: async () => ({ contact: emptyContact() }) }));
vi.mock("@/lib/career/store/images", () => ({ loadImages: async () => ({}) }));
vi.mock("@/lib/dashboard/context", () => ({ getDisplayTimeZone: () => "UTC" }));
vi.mock("@/lib/career/render/pdf-client", () => ({ renderPdf: vi.fn() }));

import { POST } from "@/app/api/career/documents/pages/route";
import { renderPdf } from "@/lib/career/render/pdf-client";
import { emptyContact } from "@/lib/career/schema/contact";
import { document } from "./document-fixtures";
import { tempCareer } from "./fixtures";
import { textPdf } from "./engine/helpers/pdf";

let temp: ReturnType<typeof tempCareer>;
beforeEach(() => { temp = tempCareer(); });
afterEach(() => { temp.cleanup(); vi.clearAllMocks(); });
function request() {
  return new Request("http://localhost/api/career/documents/pages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document: document(), doc: "resume" }),
  });
}

it("returns PDF-only checks from real PDF parsing", async () => {
  vi.mocked(renderPdf).mockResolvedValue({ ok: true, pdf: new Uint8Array(textPdf([[], [], []])), pages: 3 });
  const response = await POST(request());
  expect(await response.json()).toMatchObject({
    ok: true, pages: 3, budget: { pages: 2, exceeded: true },
    findings: expect.arrayContaining([expect.objectContaining({ code: "career.check.pages" })]),
  });
});

it("preserves service page count when advisory text parsing fails", async () => {
  vi.mocked(renderPdf).mockResolvedValue({ ok: true, pdf: new Uint8Array(Buffer.from("%PDF-invalid")), pages: 3 });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ok: true, pages: 3, budget: { pages: 2, exceeded: true }, findings: [], code: "pdf_checks_failed",
  });
});

it("keeps page counting a soft failure when the service is unavailable", async () => {
  vi.mocked(renderPdf).mockResolvedValue({ ok: false, code: "pdf_unavailable" });
  expect(await (await POST(request())).json()).toEqual({
    ok: true, pages: null, budget: null, findings: [], code: "pdf_unavailable",
  });
});
