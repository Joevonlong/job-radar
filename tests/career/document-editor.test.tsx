import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
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

it("keeps edits and unsaved protection after a stale save", async () => {
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
        imageMaxBytes={1234}
        timeZone="UTC"
        warnings={[]}
      />
    </NextIntlClientProvider>,
  );
  const title = screen.getAllByLabelText("Title", { exact: true })[0]!;
  fireEvent.change(title, { target: { value: "My unsaved title" } });
  expect(hasUnsaved()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Reload before saving again"));
  expect(title).toHaveValue("My unsaved title");
  expect(hasUnsaved()).toBe(true);
  await waitFor(() => expect(screen.getByRole("button", { name: "Save document" })).toBeDisabled());
  expect(
    within(screen.getByTestId("document-history")).queryByRole("button", { name: "Restore this version" }),
  ).not.toBeInTheDocument();
  view.unmount();
  expect(hasUnsaved()).toBe(false);
});
