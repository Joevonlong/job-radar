import { render, screen } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { beforeEach, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "career") => createTranslator({ locale: "en", messages, namespace }),
}));
vi.mock("@/lib/config/career-gate", () => ({ readCareerGate: vi.fn() }));
vi.mock("@/lib/career/store/documents", () => ({ listDocuments: vi.fn() }));
vi.mock("@/lib/career/store/profile", () => ({ loadCareerProfile: vi.fn() }));
vi.mock("@/lib/dashboard/context", () => ({ getDisplayTimeZone: vi.fn() }));
vi.mock("@/lib/config/load", () => ({ reloadConfig: vi.fn() }));
vi.mock("@/app/career/documents/actions", () => ({
  loadDocumentAction: vi.fn(),
  loadPreferencesAction: vi.fn(),
  imageStateAction: vi.fn(),
  documentHistoryAction: vi.fn(),
}));
vi.mock("@/components/career/document-editor", () => ({ DocumentEditor: () => null }));
vi.mock("@/components/career/document-list", () => ({ DocumentListPage: vi.fn(() => null) }));
import { readCareerGate } from "@/lib/config/career-gate";
import { listDocuments } from "@/lib/career/store/documents";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { getDisplayTimeZone } from "@/lib/dashboard/context";
import { reloadConfig } from "@/lib/config/load";
import {
  documentHistoryAction,
  imageStateAction,
  loadDocumentAction,
  loadPreferencesAction,
} from "@/app/career/documents/actions";
import { DocumentListPage } from "@/components/career/document-list";
import ListPage from "@/app/career/documents/page";
import EditorPage from "@/app/career/documents/[id]/page";

beforeEach(() => vi.clearAllMocks());
it("gates both pages before document, image, preferences, profile or display settings reads", async () => {
  vi.mocked(readCareerGate).mockResolvedValue({ enabled: false });
  for (const page of [await ListPage(), await EditorPage({ params: Promise.resolve({ id: "doc_aaaaaaaaaa" }) })]) {
    const view = render(page);
    expect(screen.getByTestId("career-disabled")).toBeVisible();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/settings?tab=workflow");
    view.unmount();
  }
  for (const read of [
    listDocuments,
    loadCareerProfile,
    getDisplayTimeZone,
    reloadConfig,
    loadDocumentAction,
    loadPreferencesAction,
    imageStateAction,
    documentHistoryAction,
  ])
    expect(read).not.toHaveBeenCalled();
});

it("shows a back link for a missing document without loading its other state", async () => {
  vi.mocked(readCareerGate).mockResolvedValue({ enabled: true });
  vi.mocked(loadDocumentAction).mockResolvedValue({ ok: false, code: "document_missing" });
  render(await EditorPage({ params: Promise.resolve({ id: "doc_aaaaaaaaaa" }) }));
  expect(screen.getByRole("alert")).toHaveTextContent("missing or invalid");
  expect(screen.getByRole("link")).toHaveAttribute("href", "/career/documents");
  for (const read of [loadPreferencesAction, imageStateAction, documentHistoryAction])
    expect(read).not.toHaveBeenCalled();
});

it("still lists independent documents when the source profile is unreadable", async () => {
  vi.mocked(readCareerGate).mockResolvedValue({ enabled: true });
  vi.mocked(listDocuments).mockResolvedValue([{ id: "doc_aaaaaaaaaa", invalid: true }]);
  vi.mocked(loadCareerProfile).mockRejectedValue(new Error("profile_invalid"));
  render(await ListPage());
  expect(vi.mocked(DocumentListPage).mock.calls.at(-1)?.[0]).toMatchObject({
    documents: [{ id: "doc_aaaaaaaaaa", invalid: true }],
    profileEmpty: true,
    profileUnreadable: true,
  });
});
