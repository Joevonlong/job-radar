// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { careerSchema } from "@/lib/config/schemas/career";
import { renderPdf, PDF_CODES } from "@/lib/career/render/pdf-client";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const settings = careerSchema.parse({ pdf: {
  url: "http://pdf.invalid/base/", max_html_bytes: 100, timeout_seconds: 1,
} }).pdf;
afterEach(() => vi.unstubAllGlobals());

it("sends transient HTML with a timeout and returns PDF bytes and a validated page count", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("%PDF-test", {
    headers: { "Content-Type": "application/pdf", "X-Page-Count": "2" },
  }));
  vi.stubGlobal("fetch", fetcher);
  const result = await renderPdf("<p>sentinel</p>", settings);
  expect(result).toEqual({ ok: true, pages: 2, pdf: new Uint8Array(Buffer.from("%PDF-test")) });
  expect(fetcher).toHaveBeenCalledWith("http://pdf.invalid/base/render", expect.objectContaining({
    method: "POST", body: JSON.stringify({ html: "<p>sentinel</p>", tagged: true, outline: true }),
    signal: expect.any(AbortSignal), redirect: "error", cache: "no-store",
  }));
});

it.each([[413, "pdf_too_large"], [500, "pdf_failed"], [504, "pdf_failed"]])(
  "maps status %s without reading private response text", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-sentinel", { status: Number(status) })));
    expect(await renderPdf("html", settings)).toEqual({ ok: false, code });
  },
);

it("waits while the service prints another document, then returns the PDF", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("busy", { status: 429 }))
    .mockResolvedValueOnce(new Response("busy", { status: 429 }))
    .mockResolvedValueOnce(new Response("%PDF-test", { headers: { "Content-Type": "application/pdf", "X-Page-Count": "1" } }));
  vi.stubGlobal("fetch", fetcher);
  const quick = { ...settings, busy_retry_ms: 10 };
  expect(await renderPdf("html", quick)).toMatchObject({ ok: true, pages: 1 });
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("reports busy once the time limit passes without a free service", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("private-sentinel", { status: 429 })));
  vi.stubGlobal("fetch", fetcher);
  const started = performance.now();
  expect(await renderPdf("html", { ...settings, busy_retry_ms: 100 })).toEqual({ ok: false, code: "pdf_busy" });
  expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  expect(fetcher.mock.calls.length).toBeGreaterThan(1);
});

it("stops waiting for a busy service when the caller aborts", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response("busy", { status: 429 })));
  vi.stubGlobal("fetch", fetcher);
  const controller = new AbortController();
  const result = renderPdf("html", { ...settings, timeout_seconds: 60, busy_retry_ms: 5000 }, controller.signal);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  controller.abort();
  expect(await result).toEqual({ ok: false, code: "pdf_busy" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("maps network errors and timeouts without their message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-sentinel")));
  expect(await renderPdf("html", settings)).toEqual({ ok: false, code: "pdf_unavailable" });
});

it("bounds UTF-8 HTML bytes before making a request", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await renderPdf("界".repeat(34), settings)).toEqual({ ok: false, code: "pdf_too_large" });
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([null, "0", "1.5", "NaN", "9007199254740992"])("rejects invalid page counts (%s)", async (count) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-test", {
    headers: { "Content-Type": "application/pdf", ...(count === null ? {} : { "X-Page-Count": count }) },
  })));
  expect(await renderPdf("html", settings)).toEqual({ ok: false, code: "pdf_failed" });
});

it.each(["text/html", "application/pdf"])("rejects a malformed service response (%s)", async (type) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-sentinel", {
    headers: { "Content-Type": type, "X-Page-Count": "1" },
  })));
  expect(await renderPdf("html", settings)).toEqual({ ok: false, code: "pdf_failed" });
});

it("has both translations for each PDF code", () => {
  for (const code of [...PDF_CODES, "letter_missing"] as const) {
    expect(en.career.documents.status[code]).toBeTruthy();
    expect(zh.career.documents.status[code]).toBeTruthy();
  }
});
