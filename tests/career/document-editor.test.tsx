import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { document, HASH } from "./document-fixtures";
import { preferencesSchema } from "@/lib/career/schema/preferences";
import { hasUnsaved } from "@/lib/shell/unsaved";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/career/documents/actions", () => ({
  saveDocumentAction: vi.fn(),
  documentHistoryAction: vi.fn(),
  restoreDocumentVersionAction: vi.fn(),
  deleteDocumentAction: vi.fn(),
  savePreferencesAction: vi.fn(),
  deleteImageAction: vi.fn(),
}));
vi.mock("@/components/career/document-preview", () => ({ DocumentPreview: () => null }));
import { saveDocumentAction } from "@/app/career/documents/actions";
import { DocumentEditor } from "@/components/career/document-editor";
import { DocumentLayout } from "@/components/career/document-layout";
import { documentLayoutSchema } from "@/lib/career/schema/document";

it("offers every schema page budget after switching from five pages to three and back", () => {
  const initial = document();
  initial.layout.pages = 5;
  function Form() {
    const [doc, setDoc] = useState(initial);
    return (
      <DocumentLayout
        document={doc}
        onChange={(layout) => setDoc({ ...doc, layout })}
        initialPreferences={{
          preferences: preferencesSchema.parse({ schema_version: 1, layout: {}, emphasis: null, tone: null }),
          baseHash: null,
        }}
      />
    );
  }
  render(<NextIntlClientProvider locale="en" messages={messages}><Form /></NextIntlClientProvider>);
  const select = screen.getByRole("combobox", { name: messages.career.documents.layoutFields.pages });
  const pages = documentLayoutSchema.shape.pages;
  const expected = Array.from({ length: pages.maxValue! - pages.minValue! + 1 }, (_, index) =>
    String(pages.minValue! + index));
  expect(within(select).getAllByRole("option").map((option) => option.getAttribute("value"))).toEqual(expected);
  expect(select).toHaveValue("5");
  fireEvent.change(select, { target: { value: "3" } });
  expect(select).toHaveValue("3");
  fireEvent.change(select, { target: { value: "5" } });
  expect(select).toHaveValue("5");
});

it.each(["Save document", "Export résumé PDF"])("keeps edits and stops %s after a stale save", async (button) => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("export must not start"));
  vi.mocked(saveDocumentAction).mockResolvedValue({ ok: false, code: "stale" });
  const doc = document();
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DocumentEditor
        initial={{ document: doc, baseHash: HASH }}
        initialStates={{ profileChanged: false, texts: {}, entries: {} }}
        initialVersions={[]}
        preferences={{
          preferences: preferencesSchema.parse({
            schema_version: 1,
            layout: {
              lang: doc.layout.lang,
              theme: doc.layout.theme,
              accent: doc.layout.accent,
              pages: doc.layout.pages,
              paper: doc.layout.paper,
              density: doc.layout.density,
            },
            emphasis: null,
            tone: null,
          }),
          baseHash: null,
        }}
        images={{ photo: false, signature: false }}
        debounceMs={70}
        pageCountDebounceMs={3000}
        imageMaxBytes={1234}
        timeZone="UTC"
        warnings={[]}
      />
    </NextIntlClientProvider>,
  );
  const title = screen.getAllByLabelText("Title", { exact: true })[0]!;
  fireEvent.change(title, { target: { value: "My unsaved title" } });
  expect(hasUnsaved()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Reload before saving again"));
  expect(title).toHaveValue("My unsaved title");
  expect(hasUnsaved()).toBe(true);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save document" })).toBeDisabled());
  expect(
    within(screen.getByTestId("document-history")).queryByRole("button", { name: "Restore this version" }),
  ).not.toBeInTheDocument();
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRestore();
  view.unmount();
  expect(hasUnsaved()).toBe(false);
});
