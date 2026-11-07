import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { DocumentPreview } from "@/components/career/document-preview";
import { DocumentExport } from "@/components/career/document-export";
import { document } from "./document-fixtures";

const wrap = (children: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>
);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("debounces page counts separately, shows unknown and over budget, and ignores stale counts", async () => {
  vi.useFakeTimers();
  const requests: { resolve: (value: Response) => void; signal: AbortSignal }[] = [];
  const fetcher = vi.fn((url: string, init: RequestInit) => url.endsWith("/preview")
    ? Promise.resolve(Response.json({ ok: true, html: "preview", findings: [], uncovered: [] }))
    : new Promise<Response>((resolve) => requests.push({ resolve, signal: init.signal! })));
  vi.stubGlobal("fetch", fetcher);
  const doc = document();
  const view = render(wrap(
    <DocumentPreview document={doc} doc="resume" debounceMs={50} pageCountDebounceMs={200} />,
  ));
  expect(screen.getByTestId("document-page-count")).toHaveTextContent("Page count unknown");
  await act(async () => { await vi.advanceTimersByTimeAsync(199); });
  expect(requests).toHaveLength(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(requests).toHaveLength(1);
  view.rerender(wrap(
    <DocumentPreview document={{ ...doc, title: "Updated" }} doc="resume" debounceMs={50} pageCountDebounceMs={200} />,
  ));
  expect(requests[0]!.signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  await act(async () => { requests[1]!.resolve(Response.json({
    ok: true, pages: 3, budget: { pages: 2, exceeded: true },
    findings: [{ code: "career.check.pages", severity: "error", params: { pages: 3, budget: 2 } }],
  })); });
  expect(screen.getByTestId("document-page-count")).toHaveTextContent("3 pages");
  expect(screen.getByRole("alert")).toHaveTextContent("target 2");
  expect(screen.getByTestId("document-checks")).toHaveTextContent("3 pages; budget 2");
  await act(async () => { requests[0]!.resolve(Response.json({
    ok: true, pages: 1, budget: { pages: 2, exceeded: false }, findings: [],
  })); });
  expect(screen.getByTestId("document-page-count")).toHaveTextContent("3 pages");
  view.unmount();
});

it("keeps page counts unknown when the service is unavailable", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/preview")
    ? { ok: true, html: "preview", findings: [], uncovered: [] }
    : { ok: true, pages: null, budget: null, findings: [], code: "pdf_unavailable" })));
  render(wrap(<DocumentPreview document={document()} doc="resume" debounceMs={50} pageCountDebounceMs={100} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByTestId("document-page-count")).toHaveTextContent("Page count unknown");
  expect(screen.getByTitle("Document preview")).toHaveAttribute("srcdoc", "preview");
});

it("saves before download and refreshes checks without allowing duplicate exports", async () => {
  const saved = Promise.withResolvers<boolean>();
  const onSave = vi.fn(() => saved.promise);
  const onExported = vi.fn();
  const fetcher = vi.fn(async () => new Response("%PDF-test", { headers: {
    "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"Example.pdf\"",
  } }));
  vi.stubGlobal("fetch", fetcher);
  const create = vi.fn(() => "blob:test");
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  render(wrap(<DocumentExport document={document()} disabled={false} findings={[]} uncovered={[]}
    onSave={onSave} onExported={onExported} onBusy={vi.fn()} />));
  fireEvent.click(screen.getByRole("button", { name: "Export résumé PDF" }));
  expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { saved.resolve(true); });
  await waitFor(() => expect(onExported).toHaveBeenCalledWith("resume"));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(click).toHaveBeenCalledTimes(1);
  expect(revoke).toHaveBeenCalledWith("blob:test");
  expect(click.mock.instances[0]).toHaveAttribute("download", "Example.pdf");
});

it("stops export after a stale save", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(wrap(<DocumentExport document={document()} disabled={false} findings={[]} uncovered={[]}
    onSave={async () => false} onExported={vi.fn()} onBusy={vi.fn()} />));
  fireEvent.click(screen.getByRole("button", { name: "Export résumé PDF" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Export résumé PDF" })).toBeEnabled());
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([[429, "pdf_busy", "Export in progress, please wait."],
  [503, "pdf_unavailable", "COMPOSE_PROFILES=career-pdf"]] as const)(
  "shows a translated export failure for status %s with advisory findings", async (status, error, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error }, { status })));
    render(wrap(<DocumentExport document={document()} disabled={false}
      findings={[{ code: "career.lint.placeholder", params: { text: "TODO" }, severity: "error" }]}
      uncovered={["中", "文"]} onSave={async () => true} onExported={vi.fn()} onBusy={vi.fn()} />));
    expect(screen.getByTestId("document-font-hint")).toHaveTextContent("中 文");
    expect(screen.getByText("Placeholder remains: TODO")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Export letter PDF" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export résumé PDF" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes(text))).toBe(true));
    expect(screen.getByRole("button", { name: "Export résumé PDF" })).toBeEnabled();
  },
);

it("keeps résumé export hints when the selected letter is empty", async () => {
  vi.useFakeTimers();
  const hints = {
    findings: [{ code: "career.lint.placeholder", params: { text: "TODO" }, severity: "error" }],
    uncovered: ["中"],
  };
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ ok: true, html: "resume", ...hints, exportHints: hints }));
  const onHints = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(wrap(<DocumentPreview document={document()} doc="letter" debounceMs={50} pageCountDebounceMs={100}
    onHints={onHints} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ doc: "resume" });
  expect(onHints).toHaveBeenCalledWith(hints);
  expect(screen.queryByTitle("Document preview")).not.toBeInTheDocument();
  expect(screen.queryByTestId("document-page-count")).not.toBeInTheDocument();
});
