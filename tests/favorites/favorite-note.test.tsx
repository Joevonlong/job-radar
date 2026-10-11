import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FavoriteNote } from "@/components/favorites/favorite-note";
import { FAVORITE_NOTE_MAX_CHARS } from "@/lib/dashboard/limits";

import en from "../../messages/en.json";

const mocks = vi.hoisted(() => ({ saveFavoriteNoteAction: vi.fn(), toastTone: vi.fn() }));
vi.mock("@/app/favorites/actions", () => ({ saveFavoriteNoteAction: mocks.saveFavoriteNoteAction }));
vi.mock("@/lib/toast", () => ({ toastTone: mocks.toastTone, toastUndo: vi.fn() }));

const note = (value: string | null, onRowClick = vi.fn()) =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <div role="group" onClick={onRowClick}>
        <FavoriteNote jobId={5} title="LLM Engineer" note={value} starredLabel="3 days ago" starredTitle="Oct 5" />
      </div>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveFavoriteNoteAction.mockImplementation(async ({ note: text }: { note: string }) => ({ ok: true, note: text.trim() === "" ? null : text.trim() }));
});

describe("FavoriteNote", () => {
  it("shows when the job was starred and the note, or an add link without one", () => {
    const { unmount } = note("ask about visa");
    expect(screen.getByText(/starred 3 days ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit note: LLM Engineer" })).toHaveTextContent("ask about visa");
    unmount();
    note(null);
    expect(screen.getByRole("button", { name: "Edit note: LLM Engineer" })).toHaveTextContent("Add note");
  });

  it("Enter saves, shows the new note and toasts", async () => {
    const user = userEvent.setup();
    note(null);
    await user.click(screen.getByRole("button", { name: "Edit note: LLM Engineer" }));
    await user.type(screen.getByTestId("fav-note-input"), "call Anna{Enter}");
    await waitFor(() => expect(mocks.saveFavoriteNoteAction).toHaveBeenCalledWith({ jobId: 5, note: "call Anna" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit note: LLM Engineer" })).toHaveTextContent("call Anna"));
    expect(mocks.toastTone).toHaveBeenCalledWith("success", "Note saved");
  });

  it("leaving the field saves too, and an emptied field clears the note", async () => {
    const user = userEvent.setup();
    note("old");
    await user.click(screen.getByRole("button", { name: "Edit note: LLM Engineer" }));
    await user.clear(screen.getByTestId("fav-note-input"));
    await user.tab();
    await waitFor(() => expect(mocks.saveFavoriteNoteAction).toHaveBeenCalledWith({ jobId: 5, note: "" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit note: LLM Engineer" })).toHaveTextContent("Add note"));
  });

  it("Esc cancels without saving", async () => {
    const user = userEvent.setup();
    note("keep me");
    await user.click(screen.getByRole("button", { name: "Edit note: LLM Engineer" }));
    await user.type(screen.getByTestId("fav-note-input"), " and more{Escape}");
    expect(screen.queryByTestId("fav-note-input")).toBeNull();
    expect(mocks.saveFavoriteNoteAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit note: LLM Engineer" })).toHaveTextContent("keep me");
  });

  it("refuses a note over the limit and says so", async () => {
    const user = userEvent.setup();
    note(null);
    await user.click(screen.getByRole("button", { name: "Edit note: LLM Engineer" }));
    await user.click(screen.getByTestId("fav-note-input"));
    await user.paste("x".repeat(FAVORITE_NOTE_MAX_CHARS + 5));
    await user.keyboard("{Enter}");
    expect(mocks.saveFavoriteNoteAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("fav-note-error")).toHaveTextContent(`at most ${FAVORITE_NOTE_MAX_CHARS} characters`);
  });

  it("clicks inside do not reach the row (which would open the job)", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    note("n", onRowClick);
    await user.click(screen.getByRole("button", { name: "Edit note: LLM Engineer" }));
    await user.click(screen.getByTestId("fav-note-input"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
